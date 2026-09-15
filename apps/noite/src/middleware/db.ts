/**
 * Ensure SQLite schema before actions / auth.
 * Bun Oxide has no Worker D1 binding — DB is process-local.
 */
export default async function db() {
  const { ensureDbPromise } = await import("../lib/db");
  await ensureDbPromise();
}
