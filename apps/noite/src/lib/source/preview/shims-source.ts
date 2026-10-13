//! The shim sources, as text, for the harness to write into the pod. The text
//! is inlined at build time — the repo's own way of carrying a file into the
//! bundle (`ts-worker.ts` does the same for TypeScript's libs) — so no runtime
//! fetch and no emitted asset stands between the panel and the pod.
//!
//! Both properties matter: the sources are inlined (a lazy `import()` of this
//! module once made the SSR build point at the client's chunk of it, which a
//! celld deploy cannot resolve), and the glob keeps the module list in one
//! place — adding a shim file writes it into the pod automatically.

/** Every shim module, by the file name it is written under. */
export const SHIM_SOURCES: Record<string, string> = {};
for (const [specifier, source] of Object.entries(
  import.meta.glob<string>("./shims/*.mjs", {
    eager: true,
    exhaustive: true,
    import: "default",
    query: "?raw",
  })
)) {
  SHIM_SOURCES[specifier.slice(specifier.lastIndexOf("/") + 1)] = source;
}
