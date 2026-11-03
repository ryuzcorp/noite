### Added

- Void sandbox controller bundle (build only, not deployed yet): `apps/void-sandbox` compiles the fixed `noite-void-sandbox` controller (`SandboxController` DO + fleet-local `NoiteSandboxAdmission` DO) from the pinned `void` 1.5.0 npm version, and the image ships it at `/opt/noite/void-sandbox/{worker.js,meta.json}`. The runner deploy pipeline that renders its config and deploys it follows separately; no behavior changes until then.
