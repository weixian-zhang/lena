Replace exact text in an existing file.

- Use `edit` for every incremental change to an existing file, especially small ones. Do not rewrite the file with `write` or `bash` `sed`.
- `read` the file before editing it. Do not call `edit` from memory, stale context, or a guessed `old_string`.
- Take `old_string` and `new_string` from the `read` output, dropping the `<line-number>\t` prefix; match only file content.
- `old_string` must occur exactly once unless `replace_all` is set. If it is ambiguous, add surrounding context. Use `replace_all` only when every occurrence should change — for example, renaming a symbol throughout the file.
- Edits to the same file apply in order, each to the file as the previous one left it. If an earlier edit changed the text a later `old_string` relies on, `read` the file again first.
- For CRLF files, `read` shows LF; use LF in `old_string` and `new_string`, and `edit` writes CRLF back.
