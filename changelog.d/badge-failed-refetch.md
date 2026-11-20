### Fixed

- The app page's status badge now recovers from a control-plane blip on its own: when the refetch after a Stop or Start fails every attempt, the page re-checks against the newest streamed state on a bounded backoff (5 s doubling, at most 30 s apart) until they agree. The exception noted in `0.2.0-beta.1` — a badge stuck on its old value until the next state change or a reload — is gone.
