### Fixed

- Large `git push`es (past git's 1 MiB `http.postBuffer`) no longer fail: the client first POSTs a flush-only RPC probe (`0000`) and streams the real pack only on a 200, and the runner answered that probe 403. The probe now answers 200 with an empty result after the usual key authorization, without touching any ref, and the chunked follow-up streams past the 2 MiB default body limit under a cap of `RUNNER_BUILD_MAX_MB` (a bigger bundle could never deploy past the worktree quota anyway; over the cap is 413 naming the knob).
