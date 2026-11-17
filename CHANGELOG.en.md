# Changelog

## 0.1.0

First release.

- Blocks `write`, `edit`, `bash`, and `run_code` from writing into built-in system directories.
- Allows same-named directories inside the project, `allowedPaths`, and the optional platform temp directory.
- Real path resolution: symbolic links, `..`, and `/tmp` aliases.
- The project root is anchored to the session creation directory, preventing a bypass by switching the working directory mid-session.
- Denials suggest a replacement location built from the mirror base, the blocked root, and the relative path.
- Optional read log and denial log, JSONL, configurable path.
- Inline settings page on the Plugins page; all settings hot-reload.