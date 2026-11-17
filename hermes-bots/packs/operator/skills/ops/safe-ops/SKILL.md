---
name: safe-ops
description: Approval and rollback discipline for commands that change state.
version: 1.0.0
metadata:
  hermes:
    tags: [ops, safety]
    category: ops
    requires_toolsets: [terminal]
---

# Safe Ops

## When to Use

Before running any command that modifies files, services, data, or remote systems.

## Procedure

1. Inspect the target first (list, dry-run, `--check`).
2. State the exact command and its effect; get approval if it is destructive or outward-facing.
3. Record the previous state (backup, previous version, git commit) before changing.
4. Run it, then verify the effect with a read-only check.
5. Report the result and the rollback command.

## Pitfalls

- Wildcard deletes and `sudo` need explicit approval every time.
- Never place secrets in command lines or logs.

## Verification

Post-change check output is quoted and the rollback path is stated.
