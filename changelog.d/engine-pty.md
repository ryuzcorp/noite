### Added

- Container exec can now allocate a PTY: `exec()` takes `pty: true` (or `{ cols, rows }` for an initial size), the process reports `isPty`, and `process.resize(cols, rows)` resizes the terminal. The engine proxy accepts `Tty` execs and `POST /exec/{id}/resize` for a fleet's own execs only.
