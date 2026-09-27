Read an image file so you can view it.

- Supports PNG, JPEG, GIF and WebP, up to {{ MAX_IMAGE_MEGABYTES }} MB. The type is detected from the file's bytes, not its extension.
- For other image formats, or larger images, create a converted or smaller copy with `bash`, then read that copy. Do not retry the unchanged file.
- Relative paths resolve against the working directory the `bash` tool runs in; any other location needs an absolute path.
- Only images can be read. For text files use `read`. To list directories, use `ls` via `bash` for a known directory, or `find` via `bash` for pattern search.
- A missing or invalid path returns an error you can handle.
- When you need several images, read them in one response instead of one per turn.
- After generating or editing an image with a command or script, read the result back before continuing.
