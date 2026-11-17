---
name: pr-workflow
description: Branch, commit, and open a pull request with a clear description.
version: 1.0.0
metadata:
  hermes:
    tags: [git, github]
    category: engineering
    requires_toolsets: [terminal]
---

# PR Workflow

## When to Use

The user asks to commit, push, or open a pull request.

## Procedure

1. Check `git status` and `git diff`; never commit unrelated files.
2. Work on a feature branch, not the default branch.
3. Commit with an imperative subject under 72 chars and a body explaining why.
4. Push the branch. Open a PR only when the user asked for one.
5. PR body: what changed, why, how it was verified, known gaps.

## Pitfalls

- No force-push or history rewrite without explicit approval.
- Never commit secrets; check the diff for keys and `.env` files.
- Follow the repository's PR template if one exists.

## Verification

`git status` is clean, the branch is pushed, and the PR link is reported.
