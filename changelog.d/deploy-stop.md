### Added

- **Stop an in-flight deploy.** The Deployments tab's in-flight row has a **Stop** button (push/admin): the step running at that moment is killed with its whole process group, every later phase checks the stop, and the row closes as failed with `cancelled by the operator`. The release serving traffic is untouched, and the app's next push deploys normally.
