Create a file, or replace an existing one entirely.

- Relative paths resolve against the working directory the `bash` tool runs in; any other location needs an absolute path.
- Missing parent directories are created automatically.
- Use `write` only when the file does not exist, or you intend a complete replacement. For incremental changes to an existing file, use `edit` instead.
- `read` an existing file before overwriting it.
- Pass the complete file content. Never include the `<line-number>\t` prefixes from `read` output.
- Content is written literally, including its line endings: `\n` stays LF, `\r\n` stays CRLF.
- Do not create unsolicited documentation files (`*.md` write-ups, READMEs, summaries) just because a task finished; write one only when the user asks for it.
