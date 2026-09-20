---
name: cm
description: Write a short commit message — a semantic `type(scope): description` title plus a one or two line body — for the staged or uncommitted changes. Use when the user asks for a commit message, or invokes /cm.
---

# Commit message

Produce a commit message for the current changes.

First look at what changed:

- `git status --short`
- `git diff HEAD` (or `git diff --cached` if anything is staged)

Then output exactly this, and nothing else:

```
<title>

<body>
```

**Title** — `type(scope): description`, one line, under 72 characters, no
trailing period. The description is imperative mood ("add", "fix", "rename") and
says what the change does, not which files moved.

Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`. Scope is the module
touched — `session`, `api`, `agent`, `routine`, or a pipeline stage (`ingest`,
`derive`, `catalog`, `aggregate`, `export`). Drop the scope when the change
spans several.

**Body** — one or two lines saying why, or what a reader could not guess from
the title. Drop it entirely if the title already covers it.

Rules:

- Short beats complete. If a line does not help someone reading `git log`, cut it.
- `Body` bullet lists, no file inventories, no caveats, no follow-up suggestions.
- Output the message only — do not commit, stage, or push.
