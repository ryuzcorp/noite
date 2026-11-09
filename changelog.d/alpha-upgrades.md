### Operator action required

- None for an install on the compacted baseline (alpha.28 onward): re-run `curl -fsSL https://noite.now/run.sh | bash -s install` (or `install --pre`) to upgrade in place — `.env` and the volumes are kept and the runner restarts with every fleet, as before. A database from before the 2026-11-09 compaction (alpha.27 and earlier) is still refused: back it up, then uninstall and install fresh.

### Fixed

- Alpha upgrades work again: `install.sh` re-run is the upgrade (it keeps `.env` and the volumes, refreshes `compose.yaml` and the image, and restarts the runner and every fleet), `uninstall.sh` keeps `NOITE_KEEP_DATA=1`, and `run.sh` accepts `--yes` again. The 2026-11-09 schema compaction is unchanged: both migration runners stay, the compacted baselines apply, and a pre-compaction database is refused with an operator message instead of being reshaped.
