### Fixed

- **A slow static asset can no longer be answered with a 15 s JSON 504.** The control UI's `run_worker_first` now excludes `/assets/*`, so static chunks are served by the asset layer instead of behind the Worker's session check, per-request database bootstrap, rate limit and 15 s action bound. The 29-byte `{"error":"Request timed out"}` bodies the e2e "flake wave" traced to shared chunks such as `pages-client`, `Data`, `branches` and `errors` are gone.
