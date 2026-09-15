-- Seed the demo D1 database: a simple visits table for the preview panel.
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  url TEXT NOT NULL
);
