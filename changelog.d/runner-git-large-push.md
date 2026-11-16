### Fixed

- Large `git push`es (past git's 1 MiB `http.postBuffer`) no longer fail: the client first POSTs a flush-only RPC probe (`0000`) and streams the real pack only on a 200, and the runner answered that probe 403. The probe now answers 200 with an empty result without touching any ref, and the chunked follow-up streams past the 2 MiB default body limit into a temp spool file under the work dir (never RAM), capped at `RUNNER_BUILD_MAX_MB` — over the cap is 413 naming the knob, and the spool file is removed on every exit path. Only a 1 MiB head window is read before key auth.
