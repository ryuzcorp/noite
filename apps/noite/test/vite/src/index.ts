// `?raw` is a Vite-only import: it resolves only when the runner deploys
// the build output instead of bundling this file from source.
import greeting from "./greeting.txt?raw";

export default {
  fetch(request: Request): Response {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/greeting") {
      return Response.json({ greeting: greeting.trim() });
    }

    if (pathname === "/api/boom") {
      // E2E hook (sourcemaps.spec.ts): throws inside the Worker so the
      // Errors tab records a Worker issue symbolicated to this file.
      throw new Error("worker-boom");
    }

    return new Response("not found", { status: 404 });
  },
};
