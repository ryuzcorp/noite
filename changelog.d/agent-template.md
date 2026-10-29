### Added

- **Agent app template.** The create page offers a third template, `agent`: a Pi agent harness on Durable Objects (Pi Durable) with tools in a Sandbox container. The runner's built-output allowlist now preserves the top-level `containers` key (celld 0.6 container classes), so the template's `dist/wrangler.json` deploys intact. Sandbox containers need a container engine on the fleet host.
