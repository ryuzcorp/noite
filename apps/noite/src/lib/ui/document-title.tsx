//! Document title for data- or query-derived titles.
//!
//! Static titles live in each page's `.server.ts` (`defineHead`). When the
//! title needs client state — the app's name once its detail loads, the
//! compare range while its pickers write the query in place — render this:
//! it assigns `document.title` during render (idempotent, outside the
//! reactive graph, so it can never loop) and skips SSR, where the server
//! head already set the fallback title.

export const DocumentTitle = ({ title }: { title: string }) => {
  if (typeof document !== "undefined") {
    document.title = title;
  }

  return null;
};
