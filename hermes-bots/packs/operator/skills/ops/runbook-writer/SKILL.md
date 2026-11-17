---
name: runbook-writer
description: Capture a repeated operational procedure as a reusable runbook.
version: 1.0.0
metadata:
  hermes:
    tags: [ops, docs]
    category: ops
---

# Runbook Writer

## When to Use

You completed a procedure the user is likely to repeat.

## Procedure

1. Extract the steps actually executed, in order, with commands.
2. Add preconditions, verification, rollback, and known failure modes.
3. Offer to save it as a skill under `~/.hermes/skills/`.

## Verification

Another session could follow the runbook without the original chat.
