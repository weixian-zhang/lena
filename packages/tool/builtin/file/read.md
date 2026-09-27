Read a text file.

If you know the path of a text file, call `read` directly. Do not `ls` or otherwise pre-check it first; a missing or invalid path returns an error you can handle. Do not use `read` for directories or to search for files or content; use `bash` (`ls`, `find`, `grep`) for that.

When you need several files, read them in one response: emit multiple `read` calls together instead of one file per turn.

- Relative paths resolve against the working directory the `bash` tool runs in; any other location needs an absolute path.
- Returns up to {{ MAX_LINES }} lines or {{ MAX_BYTES_KB }} KB per call, whichever comes first; lines longer than {{ MAX_LINE_LENGTH }} characters are cut and end in `...`.
- Page through larger files with `line_offset` (1-based start line) and `n_lines`. Omit `n_lines` to read up to the {{ MAX_LINES }}-line cap.
- Only UTF-8 text files can be read. Other encodings, binary files and files containing NUL bytes are refused; use `bash` for those.
- Output format: `<line-number>\t<content>` per line. CRLF line endings are shown as plain line breaks.
- A `[...]` status line follows the file content. It says which lines were read, the file's total line count, where to continue, and which lines were cut. It is not part of the file.
- After a successful `write`, do not re-read the file only to prove the write landed.
