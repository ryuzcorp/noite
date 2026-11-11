### Changed

- The app lifecycle tables now read the runner's generated `AppStatus`, `DeployStatus` and `DesiredState` unions instead of hand-kept copies, so a status the runner adds fails the UI's compile until its label, tone and actions are decided; the schema-default `pending` row a preview environment holds until its first deploy is part of the table rather than an unknown string.
- A failed push or deploy preview now carries the workspace's typed refusal code from the pod, so the read-only explanation is chosen by code rather than by matching the error's English; the runner's refusals (protected branch, a branch that moved under the push, an invalid or existing branch) and an unreachable server still answer with text only, so those message shapes are the ones the pane reads.
