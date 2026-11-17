---
name: tdd-loop
description: Red-green-refactor loop for features and bug fixes.
version: 1.0.0
metadata:
  hermes:
    tags: [engineering, testing]
    category: engineering
    requires_toolsets: [terminal]
---

# TDD Loop

## When to Use

Implementing a feature or fixing a bug in code that has a test runner.

## Procedure

1. Find the existing test setup and conventions; mirror them.
2. Write one failing test that captures the behavior. Run it; confirm it fails for the right reason.
3. Write the minimum code to pass. Run the test.
4. Run the surrounding test file or package to catch regressions.
5. Refactor only with tests green. Repeat for the next behavior.

## Pitfalls

- A test that fails for the wrong reason (typo, import error) is not red.
- Do not test implementation details; assert observable behavior.

## Verification

New test fails before the change and passes after; package tests still pass.
