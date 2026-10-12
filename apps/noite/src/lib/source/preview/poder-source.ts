//! Poder's built ESM, as text, for the harness to write into the pod. The text
//! is inlined at build time — the repo's own way of carrying a file into the
//! bundle (`ts-worker.ts` does the same for TypeScript's libs, and
//! `shims-source.ts` for the remaining shim) — so no runtime fetch and no
//! emitted asset stands between the panel and the pod.
//!
//! Both properties matter: the sources are inlined (a lazy `import()` of a
//! carrying module once made the SSR build point at the client's chunk of it,
//! which a celld deploy cannot resolve — verify with `bun run build` and a
//! grep for stray chunks under `apps/noite/dist/ssr`), and the glob keeps the
//! module list in one place — a file Poder's build adds lands in the pod
//! automatically.
//!
//! The files live at the root (`apps/noite/poder-dist/`, gitignored), not in
//! `node_modules`: Oxide's worker sandbox denies `?raw` module ids outside
//! the project root, which a workspace symlink would resolve to. They get
//! there three ways — `postinstall` on `bun install`, `poder_build` in
//! `docker/dev.sh`, an explicit copy in `docker/Dockerfile` — all from
//! `packages/poder/dist/`, which Poder's build must produce first.
/** Every Poder module, by the file name it is written under. */
export const PODER_SOURCES: Record<string, string> = {};
for (const [specifier, source] of Object.entries(
  import.meta.glob<string>("/poder-dist/*.mjs", {
    eager: true,
    exhaustive: true,
    import: "default",
    query: "?raw",
  })
)) {
  PODER_SOURCES[specifier.slice(specifier.lastIndexOf("/") + 1)] = source;
}
