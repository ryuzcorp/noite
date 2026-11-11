### Fixed

- The "auto deploy paused" event is recorded per target: when production and a preview environment both exhaust their automatic-deploy budget at the same sha, each now records its own event (the preview's names the environment) instead of the second target being suppressed by the app-wide notice.
