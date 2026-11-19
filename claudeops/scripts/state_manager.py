#!/usr/bin/env python3
"""SQLite state and human-in-the-loop approval inbox for ClaudeOps.

Tables: threads, inbox_approvals, routines. Standard library only.
The database lives at workspace/04_logs/state.db (override with CLAUDEOPS_DB).
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("CLAUDEOPS_DB", ROOT / "workspace" / "04_logs" / "state.db"))
PENDING_DIR = ROOT / "workspace" / "02_inbox_pending"
STATUSES = ("PENDING", "APPROVED", "REJECTED")

SCHEMA = """
CREATE TABLE IF NOT EXISTS threads (
    thread_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name TEXT NOT NULL,
    topic      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'OPEN',
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS inbox_approvals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_name   TEXT NOT NULL,
    action_type  TEXT NOT NULL,
    payload_path TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'PENDING'
                 CHECK (status IN ('PENDING','APPROVED','REJECTED')),
    created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    cron_expr  TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    prompt     TEXT NOT NULL,
    enabled    INTEGER NOT NULL DEFAULT 1
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def cmd_init(_: argparse.Namespace) -> int:
    with connect() as conn:
        conn.executescript(SCHEMA)
    print(f"initialized {DB_PATH}")
    return 0


def cmd_queue_approval(args: argparse.Namespace) -> int:
    payload = Path(args.file)
    if not payload.is_absolute():
        payload = Path.cwd() / payload
    payload = payload.resolve()
    if not payload.is_file():
        print(f"error: payload file not found: {payload}", file=sys.stderr)
        return 2
    if PENDING_DIR.resolve() not in payload.parents:
        print(f"error: payload must live under {PENDING_DIR}", file=sys.stderr)
        return 2
    stored = payload.relative_to(ROOT).as_posix()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO inbox_approvals (agent_name, action_type, payload_path, created_at) "
            "VALUES (?, ?, ?, ?)",
            (args.agent, args.type, stored, now()),
        )
    print(f"queued approval id={cur.lastrowid} status=PENDING payload={stored}")
    return 0


def cmd_list_inbox(args: argparse.Namespace) -> int:
    sql = "SELECT * FROM inbox_approvals"
    params: tuple = ()
    if not args.all:
        sql += " WHERE status = 'PENDING'"
    elif args.status:
        sql += " WHERE status = ?"
        params = (args.status,)
    with connect() as conn:
        rows = conn.execute(sql + " ORDER BY id", params).fetchall()
    if not rows:
        print("(inbox empty)")
        return 0
    print(f"{'ID':>4}  {'STATUS':<9} {'AGENT':<18} {'TYPE':<14} PAYLOAD  (created)")
    for r in rows:
        print(
            f"{r['id']:>4}  {r['status']:<9} {r['agent_name']:<18} {r['action_type']:<14} "
            f"{r['payload_path']}  ({r['created_at']})"
        )
    return 0


def cmd_decide(args: argparse.Namespace) -> int:
    with connect() as conn:
        cur = conn.execute(
            "UPDATE inbox_approvals SET status = ? WHERE id = ? AND status = 'PENDING'",
            (args.status, args.id),
        )
        if cur.rowcount == 0:
            row = conn.execute("SELECT status FROM inbox_approvals WHERE id = ?", (args.id,)).fetchone()
            msg = f"id {args.id} not found" if row is None else f"id {args.id} already {row['status']}"
            print(f"error: {msg}", file=sys.stderr)
            return 2
    print(f"id {args.id} -> {args.status}")
    return 0


def cmd_check(args: argparse.Namespace) -> int:
    """Exit 0 only when the item is APPROVED. Agents call this before any side effect."""
    with connect() as conn:
        row = conn.execute("SELECT status FROM inbox_approvals WHERE id = ?", (args.id,)).fetchone()
    status = row["status"] if row else "NOT_FOUND"
    print(status)
    return 0 if status == "APPROVED" else 1


def cmd_new_thread(args: argparse.Namespace) -> int:
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO threads (agent_name, topic, created_at) VALUES (?, ?, ?)",
            (args.agent, args.topic, now()),
        )
    print(f"thread_id={cur.lastrowid}")
    return 0


def cmd_close_thread(args: argparse.Namespace) -> int:
    with connect() as conn:
        cur = conn.execute("UPDATE threads SET status = ? WHERE thread_id = ?", (args.status, args.id))
    if cur.rowcount == 0:
        print(f"error: thread {args.id} not found", file=sys.stderr)
        return 2
    print(f"thread {args.id} -> {args.status}")
    return 0


def cmd_list_threads(_: argparse.Namespace) -> int:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM threads ORDER BY thread_id").fetchall()
    for r in rows or []:
        print(f"{r['thread_id']:>4}  {r['status']:<8} {r['agent_name']:<18} {r['topic']}  ({r['created_at']})")
    if not rows:
        print("(no threads)")
    return 0


def cmd_add_routine(args: argparse.Namespace) -> int:
    if len(args.cron.split()) != 5:
        print("error: --cron must have 5 fields", file=sys.stderr)
        return 2
    try:
        with connect() as conn:
            cur = conn.execute(
                "INSERT INTO routines (name, cron_expr, agent_name, prompt, enabled) VALUES (?, ?, ?, ?, 1)",
                (args.name, args.cron, args.agent, args.prompt),
            )
    except sqlite3.IntegrityError:
        print(f"error: routine '{args.name}' already exists", file=sys.stderr)
        return 2
    print(f"routine id={cur.lastrowid} name={args.name}")
    return 0


def cmd_list_routines(_: argparse.Namespace) -> int:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM routines ORDER BY id").fetchall()
    for r in rows:
        flag = "on " if r["enabled"] else "off"
        print(f"{r['id']:>4}  {flag} {r['name']:<20} [{r['cron_expr']}] {r['agent_name']}: {r['prompt'][:60]}")
    if not rows:
        print("(no routines)")
    return 0


def cmd_set_routine(args: argparse.Namespace) -> int:
    with connect() as conn:
        cur = conn.execute("UPDATE routines SET enabled = ? WHERE name = ?", (1 if args.enabled == "on" else 0, args.name))
    if cur.rowcount == 0:
        print(f"error: routine '{args.name}' not found", file=sys.stderr)
        return 2
    print(f"routine {args.name} enabled={args.enabled}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="create tables").set_defaults(func=cmd_init)

    q = sub.add_parser("queue-approval", help="queue a pending file for human approval")
    q.add_argument("--agent", required=True)
    q.add_argument("--type", required=True, help="e.g. email, purchase, overwrite, shell")
    q.add_argument("--file", required=True, help="payload path under workspace/02_inbox_pending/")
    q.set_defaults(func=cmd_queue_approval)

    li = sub.add_parser("list-inbox", help="show pending approvals")
    li.add_argument("--all", action="store_true", help="include decided items")
    li.add_argument("--status", choices=STATUSES, help="with --all, filter by status")
    li.set_defaults(func=cmd_list_inbox)

    d = sub.add_parser("decide", help="approve or reject a pending item (human operator)")
    d.add_argument("--id", type=int, required=True)
    d.add_argument("--status", required=True, choices=("APPROVED", "REJECTED"))
    d.set_defaults(func=cmd_decide)

    c = sub.add_parser("check", help="exit 0 only if the item is APPROVED")
    c.add_argument("--id", type=int, required=True)
    c.set_defaults(func=cmd_check)

    nt = sub.add_parser("new-thread", help="open an isolated task thread")
    nt.add_argument("--agent", required=True)
    nt.add_argument("--topic", required=True)
    nt.set_defaults(func=cmd_new_thread)

    ct = sub.add_parser("close-thread")
    ct.add_argument("--id", type=int, required=True)
    ct.add_argument("--status", default="CLOSED")
    ct.set_defaults(func=cmd_close_thread)

    sub.add_parser("list-threads").set_defaults(func=cmd_list_threads)

    ar = sub.add_parser("add-routine", help="register a scheduled headless routine")
    ar.add_argument("--name", required=True)
    ar.add_argument("--cron", required=True, help="5-field cron expression")
    ar.add_argument("--agent", required=True)
    ar.add_argument("--prompt", required=True)
    ar.set_defaults(func=cmd_add_routine)

    sub.add_parser("list-routines").set_defaults(func=cmd_list_routines)

    sr = sub.add_parser("set-routine", help="enable or disable a routine")
    sr.add_argument("--name", required=True)
    sr.add_argument("--enabled", choices=("on", "off"), required=True)
    sr.set_defaults(func=cmd_set_routine)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command != "init" and not DB_PATH.exists():
        print("error: database missing; run 'state_manager.py init' first", file=sys.stderr)
        return 2
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
