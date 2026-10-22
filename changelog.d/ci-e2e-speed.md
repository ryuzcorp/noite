### Changed

- **CI builds the lane image once and shards each e2e lane.** The `ci.yml` image job hands its build to the lanes as a short-lived artifact, so neither lane rebuilds it; each lane's suite then splits across 2 jobs, and the Playwright browser install skips the apt step. The nightly schedule runs 3 rounds per lane and files a `flake` issue per failing spec (or comments on the open one); `workflow_dispatch` on `e2e.yml` takes a `rounds` input for the same. No suite lost a spec and nothing retries.
