### Fixed

- The MCP `deploy_status` tool reports `live: true` for a sleeping (scale-to-zero) app again — it serves on the next request — and `false` for a crash- or OOM-held fleet, whose row still reads `running` while the supervisor backs off.
- The admin Apps panel takes its Start/Stop state from the same app lifecycle as the app header, so an app that is importing (or whose import failed) no longer offers a toggle the header does not.
