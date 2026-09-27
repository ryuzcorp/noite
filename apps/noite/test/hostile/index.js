// Hostile tenant: serves build/release probe results as JSON and runs the
// Worker-side network probes live. Every probe must fail except internet
// egress — the Playwright spec asserts that.
import buildProbes from "./dist/probe.json";
import releaseProbes from "./dist/release-probe.json";

const attempt = async (name, fn) => {
  try {
    const detail = await fn();
    return [name, { detail: String(detail).slice(0, 200), ok: true }];
  } catch (error) {
    return [name, { detail: String(error).slice(0, 200), ok: false }];
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/probes") {
      const worker = {};
      const neighbour = Number(url.searchParams.get("neighbour") ?? "8101");
      const [n1, v1] = await attempt("fetch:neighbour-internal", async () => {
        const res = await fetch(`http://127.0.0.1:${neighbour}/state`, {
          method: "GET",
        });
        return `status ${res.status}`;
      });
      worker[n1] = v1;
      const [n2, v2] = await attempt("fetch:neighbour-shutdown", async () => {
        const res = await fetch(`http://127.0.0.1:${neighbour}/shutdown`, {
          method: "POST",
        });
        return `status ${res.status}`;
      });
      worker[n2] = v2;
      const [n7, v7] = await attempt("fetch:runner-loopback", async () => {
        const res = await fetch("http://127.0.0.1:8080/health");
        return `status ${res.status}`;
      });
      worker[n7] = v7;
      const [n8, v8] = await attempt("fetch:control-operator", async () => {
        const res = await fetch("http://control:8091/state");
        return `status ${res.status}`;
      });
      worker[n8] = v8;
      const [n3, v3] = await attempt("fetch:runner", async () => {
        const res = await fetch("http://runner:8080/health");
        return `status ${res.status}`;
      });
      worker[n3] = v3;
      // The fleet's own celld must reach the object store, so the egress
      // policy allows its address; the keys stay inside celld. Reaching it
      // is expected: only a store that serves data without them is a leak.
      const [n4, v4] = await attempt("fetch:rustfs", async () => {
        const res = await fetch("http://rustfs:9000/noite-e2e/");
        if (res.status === 401 || res.status === 403) {
          throw new Error(`refused without credentials (${res.status})`);
        }
        return `status ${res.status}`;
      });
      worker[n4] = v4;
      const [n5, v5] = await attempt("fetch:metadata", async () => {
        const res = await fetch("http://169.254.169.254/");
        return `status ${res.status}`;
      });
      worker[n5] = v5;
      const [n6, v6] = await attempt("fetch:internet", async () => {
        const res = await fetch("https://example.com/");
        if (!res.ok) {
          throw new Error(`status ${res.status}`);
        }
        return `status ${res.status}`;
      });
      // Inverted: internet must succeed, so ok means the probe reached it.
      worker[n6] = { detail: v6.detail, mustSucceed: true, ok: v6.ok };
      const secrets = {};
      for (const key of [
        "RUNNER_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "BETTER_AUTH_SECRET",
      ]) {
        secrets[key] = env[key] ? "present" : "absent";
      }
      return Response.json({
        build: buildProbes,
        release: releaseProbes,
        secrets,
        worker,
      });
    }
    return new Response("hostile tenant — GET /probes", { status: 404 });
  },
};
