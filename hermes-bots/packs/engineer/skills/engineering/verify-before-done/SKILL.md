---
name: verify-before-done
description: Gate every "done" claim on evidence from an executed check.
version: 1.0.0
metadata:
  hermes:
    tags: [engineering, quality]
    category: engineering
    requires_toolsets: [terminal]
---

# Verify Before Done

## When to Use

Before saying a change works, a bug is fixed, or a task is complete.

## Procedure

1. List the acceptance criteria in one line each.
2. For each criterion, run the narrowest command that proves it (focused test, type check, a real invocation).
3. Read the output. Do not assume success from exit code alone when output says otherwise.
4. Report: command run, result, and anything not verified.

## Pitfalls

- Re-running a passing check adds nothing; run the check that covers what changed.
- Passing tests that never exercised the changed path prove nothing. Confirm the test fails without the change when practical.
- Never skip, disable, or loosen a test to get green.

## Verification

The final message names every command run and what each showed, and lists unverified items explicitly.
