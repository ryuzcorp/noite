// OOM probe: `/grow?mb=N` pins N MiB in the isolate (held, never freed),
// so repeated calls grow the fleet past its cgroup cap; `/` reports
// liveness. Each call stays far under the per-isolate V8 heap limit, so the
// kernel's per-fleet `memory.max` is what trips — not the isolate cap.
const holdings = [];

export default {
  fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/grow") {
      const mb = Math.min(Number(url.searchParams.get("mb") ?? "64"), 256);
      holdings.push(new Uint8Array(mb * 1024 * 1024).fill(7));

      return Response.json({ held: holdings.length, mb });
    }

    return Response.json({ held: holdings.length, ok: true });
  },
};
