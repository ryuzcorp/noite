### Fixed

- **A successful `noite deploy` no longer reports CI failure afterwards.** `$GITHUB_OUTPUT` is written as soon as the push lands, and a write error (disk full, unwritable path) now warns instead of failing the step: the deploy is already live and cannot be undone.
- **A failing `gh` call on the deploy PR comment is reported** with its exit code and stderr, instead of the create/update calls being silently treated as success.
- **A retained deploy temp dir no longer contains the API key.** Git authenticates through its environment header instead of a key in the remote URL, so the workdir's `.git/config` never holds the token, and a kept workdir has URL userinfo scrubbed before it is retained.
