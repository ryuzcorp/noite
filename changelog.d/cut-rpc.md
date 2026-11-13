### Changed

- **The runner's JSON-RPC mirror is gone.** `POST /rpc` (`apps/runner/src/api/rpc.rs`, the `axum-jrpc` dependency and its parity tests) is removed; the control UI's runner client, the MCP tool table, envelope ingest and the e2e suites all call the REST `/v1` surface directly, so there is one transport left to maintain and one error model (an HTTP status plus the runner's own plain-text message).
- The REST surface gained the routes that only the mirror had, so every former RPC caller has an equivalent: `GET /v1/apps/by-slug/{slug}`, `GET`/`PUT /v1/apps/{id}/limits`, `GET /v1/apps/{id}/errors?status=&environmentId=`, `GET`/`PATCH /v1/apps/{id}/errors/{fingerprint}`, `GET /v1/apps/{id}/errors/ingest-key?role=`, `POST /v1/apps/{id}/errors/ingest-key/rotate?role=`, `POST /v1/errors/ingest` (project-addressed, the key carries the app) and `POST /v1/apps/{id}/storage/r2/{bucket}/delete` (1..100 keys in one batch).
- The API reference (`apps/website/docs/reference/api.mdx`) documents those routes and no longer has an RPC section; `SPEC.md` and `AGENTS.md` describe the runner as a single REST transport.

### Operator action required

- **Clients that posted JSON-RPC to `POST /rpc` must move to the REST `/v1` equivalents listed above.** The mirror answered `200` with a JSON-RPC `error.code`; the REST routes answer the HTTP status itself (`400`/`403`/`404`/`409`/`500`) with the runner's message as a plain-text body, so a client that parsed `error.code` or JSON-RPC batches needs its status handling updated. No configuration or data migration is involved, and the control UI ships with the image, so nothing else changes on upgrade.
