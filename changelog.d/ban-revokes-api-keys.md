### Fixed

- **Banning an account revokes its API keys.** `banUser` deleted the account's sessions but left its profile API keys working, so a banned user could keep pushing over git smart-HTTP, posting event ingest, and calling `/mcp`. Every key consumer now refuses a key whose owner is banned through one shared predicate (`lib/server/api-keys.server.ts`), and a ban deletes the account's keys in the same flow. Unbanning does not restore a deleted key — mint a new one.
