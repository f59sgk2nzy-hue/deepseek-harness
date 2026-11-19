#!/usr/bin/env python3
"""Headless routine runner for ClaudeOps.

Reads enabled rows from the `routines` table and runs each through
`claude -p "<prompt>" --agent <agent> --output-format json`, logs output and
token metrics to workspace/04_logs/, then commits the workspace to Git.

  run_routine.py --name NAME     run one routine now
  run_routine.py --due           run routines whose cron_expr matches the current minute
  run_routine.py --all           run every enabled routine now
  add --dry-run to print the command without calling claude
Schedule with system cron:  * * * * * cd /path/to/claudeops && python3 scripts/run_routine.py --due
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import state_manager as sm  # noqa: E402

ROOT = sm.ROOT
LOG_DIR = ROOT / "workspace" / "04_logs"


def _field_matches(field: str, value: int, lo: int, hi: int) -> bool:
    for part in field.split(","):
        step = 1
        if "/" in part:
            part, s = part.split("/", 1)
            step = int(s)
        if part == "*":
            start, end = lo, hi
        elif "-" in part:
            a, b = part.split("-", 1)
            start, end = int(a), int(b)
        else:
            start = end = int(part)
            if step != 1:
                end = hi
        if start <= value <= end and (value - start) % step == 0:
            return True
    return False


def cron_matches(expr: str, when: datetime) -> bool:
    """Standard 5-field cron (min hour dom month dow; dow 0 or 7 = Sunday)."""
    minute, hour, dom, month, dow = expr.split()
    cron_dow = (when.weekday() + 1) % 7
    dow_ok = _field_matches(dow, cron_dow, 0, 7) or (cron_dow == 0 and _field_matches(dow, 7, 0, 7))
    dom_ok = _field_matches(dom, when.day, 1, 31)
    if dom != "*" and dow != "*":
        day_ok = dom_ok or dow_ok  # cron ORs the day fields when both are restricted
    else:
        day_ok = dom_ok and dow_ok
    return (
        _field_matches(minute, when.minute, 0, 59)
        and _field_matches(hour, when.hour, 0, 23)
        and _field_matches(month, when.month, 1, 12)
        and day_ok
    )


def build_command(agent: str, prompt: str, args: argparse.Namespace) -> list[str]:
    cmd = ["claude", "-p", prompt, "--agent", agent, "--output-format", "json",
           "--permission-mode", args.permission_mode]
    if (ROOT / ".mcp.json").exists():
        cmd += ["--mcp-config", str(ROOT / ".mcp.json")]
    if args.max_budget_usd:
        cmd += ["--max-budget-usd", str(args.max_budget_usd)]
    return cmd


def extract_metrics(stdout: str) -> dict:
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return {}
    usage = data.get("usage") or {}
    return {
        "is_error": data.get("is_error"),
        "duration_ms": data.get("duration_ms"),
        "num_turns": data.get("num_turns"),
        "total_cost_usd": data.get("total_cost_usd"),
        "input_tokens": usage.get("input_tokens"),
        "output_tokens": usage.get("output_tokens"),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
        "cache_creation_input_tokens": usage.get("cache_creation_input_tokens"),
        "session_id": data.get("session_id"),
    }


def git_commit(message: str) -> str:
    def git(*a: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", "-C", str(ROOT), *a], capture_output=True, text=True)

    if git("rev-parse", "--is-inside-work-tree").returncode != 0:
        return "no git repo"
    git("add", "-A")
    if git("diff", "--cached", "--quiet").returncode == 0:
        return "nothing to commit"
    r = git("-c", "user.name=ClaudeOps", "-c", "user.email=claudeops@localhost", "commit", "-q", "-m", message)
    return "committed" if r.returncode == 0 else f"commit failed: {r.stderr.strip()}"


def run_one(row, args: argparse.Namespace) -> int:
    cmd = build_command(row["agent_name"], row["prompt"], args)
    if args.dry_run:
        print("DRY RUN:", " ".join(repr(c) if " " in c else c for c in cmd))
        return 0
    with sm.connect() as conn:
        tid = conn.execute(
            "INSERT INTO threads (agent_name, topic, created_at) VALUES (?, ?, ?)",
            (row["agent_name"], f"routine:{row['name']}", sm.now()),
        ).lastrowid
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    base = LOG_DIR / f"{stamp}_{row['name']}"
    try:
        proc = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=args.timeout)
        rc, out, err = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        rc, out, err = 124, (e.stdout or ""), f"timeout after {args.timeout}s"
    except FileNotFoundError:
        rc, out, err = 127, "", "claude CLI not found on PATH"
    base.with_suffix(".stdout.json").write_text(out)
    base.with_suffix(".stderr.log").write_text(err)
    metrics = extract_metrics(out)
    with (LOG_DIR / "metrics.jsonl").open("a") as f:
        f.write(json.dumps({"ts": sm.now(), "routine": row["name"], "agent": row["agent_name"],
                            "thread_id": tid, "exit_code": rc, **metrics}) + "\n")
    with sm.connect() as conn:
        conn.execute("UPDATE threads SET status = ? WHERE thread_id = ?",
                     ("DONE" if rc == 0 else "FAILED", tid))
    print(f"[{row['name']}] exit={rc} metrics={metrics or 'n/a'}")
    msg = "routine %s thread %s exit %s" % (row["name"], tid, rc)
    print(f"[{row['name']}] git: {git_commit(msg)}")
    return rc


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--name")
    g.add_argument("--due", action="store_true")
    g.add_argument("--all", action="store_true")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--timeout", type=int, default=1800)
    p.add_argument("--permission-mode", default=os.environ.get("CLAUDEOPS_PERMISSION_MODE", "acceptEdits"),
                   choices=["default", "acceptEdits", "plan", "dontAsk", "auto"])
    p.add_argument("--max-budget-usd", type=float, default=None)
    args = p.parse_args(argv)

    if not sm.DB_PATH.exists():
        print("error: database missing; run state_manager.py init", file=sys.stderr)
        return 2
    with sm.connect() as conn:
        rows = conn.execute("SELECT * FROM routines WHERE enabled = 1 ORDER BY id").fetchall()
    if args.name:
        rows = [r for r in rows if r["name"] == args.name]
        if not rows:
            print(f"error: no enabled routine named '{args.name}'", file=sys.stderr)
            return 2
    elif args.due:
        now = datetime.now()
        rows = [r for r in rows if cron_matches(r["cron_expr"], now)]
    if not rows:
        print("no routines to run")
        return 0
    worst = 0
    for r in rows:
        worst = max(worst, run_one(r, args))
    return worst


if __name__ == "__main__":
    sys.exit(main())
