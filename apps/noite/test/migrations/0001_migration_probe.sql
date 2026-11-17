-- Tenant D1 migration probe for the upgrade lane (H3): the lane's seed
-- deploys this Worker with this directory, then redeploys on the upgraded
-- tree and asserts every pending file applied exactly once (one row each in
-- `d1_migrations`) and the Worker serves the migrated schema.
--
-- Releases before the deploy-time apply left this directory alone, so the
-- Worker keeps creating the tables it writes on first open: this file must
-- stay valid whether or not the deploy applied it.
CREATE TABLE migration_probe (
  id INTEGER PRIMARY KEY,
  note TEXT NOT NULL
);
INSERT INTO migration_probe (id, note) VALUES (1, 'seeded-by-0001');
