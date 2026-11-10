### Fixed

- **A successful `noite deploy` no longer reports CI failure afterwards.** `$GITHUB_OUTPUT` is written as soon as the push lands, and a write error (disk full, unwritable path) now warns instead of failing the step: the deploy is already live and cannot be undone.
- **A failing `gh` call on the deploy PR comment is reported.** A non-zero exit from `gh pr comment` or the PATCH now names the exit and its stderr in the warning; previously only the comment-list call checked the exit code and the create/update calls were silently treated as success.
- **A retained deploy temp dir no longer contains the API key.** Git authenticates through its environment header instead of a key in the remote URL, so the workdir's `.git/config` never holds the token, and a kept workdir has URL userinfo scrubbed before it is retained.

### Changed

- The CLI's connection resolution, deploy phases, push mode, temp-dir cleanup, PR-comment outcome, GitHub Actions context and MCP call outcome are explicit `Data.TaggedEnum` state machines with one transition/classification function each. Flags, stdout and exit-code meanings are unchanged.
