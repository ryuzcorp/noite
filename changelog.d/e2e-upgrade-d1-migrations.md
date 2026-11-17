### Fixed

- The upgrade lane now covers tenant D1 migrations: the seeded sample Worker ships a `migrations/` dir (ignored by releases before the deploy-time apply), and after the upgrade the lane redeploys on the tree with a new migration file — proving every pending file applies exactly once (one `d1_migrations` row each, served back by the Worker) — then redeploys again and proves nothing applies twice.
