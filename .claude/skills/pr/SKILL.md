---
name: pr
description: Write a short pull request message for the current branch — summary, why, and the key changed files. Use when the user asks for a PR message/description, or invokes /pr. Takes an optional base branch argument (defaults to main).
---

# PR message

Produce a pull request message from the changes on the current branch compared to
a base branch.

The base branch is whatever argument was passed to this skill. If no argument was
given, use `main`. Below, `$BASE` means that branch.

First gather the diff context by running:

- `git diff --stat $BASE...HEAD` (list of changed files)
- `git diff $BASE...HEAD` (full diff to understand what changed)
- `git log --oneline $BASE..HEAD` (commit messages for extra context)

Then output a PR message in exactly this format:

## Summary

3-5 short bullets covering only the key changes — what a reviewer needs to know.
One line each. Skip mechanics the diff already shows; say the intent.

## Why

One sentence.

## Changed Files

Only the files that matter, one line each: path — what changed. Group related
files onto one bullet. Leave out lockfiles, config bumps, generated files, and
anything trivial.

Rules:

- Short beats complete. If a bullet does not change how someone reviews this, cut it.
- No caveats, no "note that", no follow-up suggestions, no raw diff.
- Plain words. Do not worry about grammar or polish — clarity and brevity first.
- Output the message only — do not create the PR, push, or commit anything.
