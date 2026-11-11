### Changed

- Scale to zero parks idle apps after **15 minutes** on hosts with ≤ 2 GiB of detected memory, down from 1 hour: a resident tenant fleet measures ~40–50 MB and a cold wake ~1.33 s, so parking sooner is nearly free on a small box. The sleep sweep cadence now follows the threshold (a quarter of it, clamped 5–60 minutes) instead of staying hourly, so an app actually parks near its window. Hosts with more memory keep their 6 h / 24 h tiers.
- `RUNNER_SLEEP_AFTER_MIN` (minutes) is the new fine-grained threshold knob and wins over `RUNNER_SLEEP_AFTER_H` (hours) when both are set; either set to `0` still disables sleeping install-wide, and both clamp to 30 days (`2592000` s) with a boot warning instead of failing or parking everything; an existing `RUNNER_SLEEP_AFTER_H` above `720` (e.g. `8760`, meaning "never") keeps working and boots with the clamp. Set `RUNNER_SLEEP_AFTER_H=1` to restore the previous small-host window, or `RUNNER_SLEEP_AFTER_H=24` for the older day-long one.

### Operator action required

- `docker/compose.yaml` no longer defaults `RUNNER_SLEEP_AFTER_H` to `24` or `RUNNER_SLEEP_SWEEP_S` to `3600`; unset, both derive from detected memory and the resulting threshold (15 min at ≤ 2 GiB). A compose install that wants the previous day-long window must now set `RUNNER_SLEEP_AFTER_H=24` (or `RUNNER_SLEEP_AFTER_MIN`) explicitly — otherwise its small-host apps start parking after 15 idle minutes.
