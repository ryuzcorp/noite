export class Counter {
  constructor(state, _env) {
    this.state = state;
  }
  async fetch(request) {
    console.log("visit", new Date().toISOString(), request.method, request.url);
    const n = (await this.state.storage.get("n")) ?? 0;
    // Read-only probe for the storage preview: `?read=1` reports the count
    // without advancing it.
    if (
      request.method === "GET" &&
      new URL(request.url).searchParams.get("read") === "1"
    ) {
      return Response.json({ n });
    }
    await this.state.storage.put("n", n + 1);
    return Response.json({ n: n + 1, url: request.url });
  }
}
export default {
  async fetch(request, env) {
    console.log("visit", new Date().toISOString(), request.url);
    const url = new URL(request.url);
    // Visiting GET /upload-test-txt writes a tiny test.txt to R2.
    if (url.pathname === "/upload-test-txt" && request.method === "GET") {
      await env.FILES.put("test.txt", "hello from noite test app\n", {
        httpMetadata: { contentType: "text/plain" },
      });
      return Response.json({ key: "test.txt", stored: true });
    }
    // Minimal R2 demo: PUT /files/<key> stores the body, GET /files/<key>
    // reads it back, GET /files lists keys as JSON.
    if (url.pathname === "/files" && request.method === "GET") {
      const listed = await env.FILES.list();
      return Response.json({
        objects: listed.objects.map((o) => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
        })),
      });
    }
    if (url.pathname.startsWith("/files/") && request.method === "PUT") {
      const key = decodeURIComponent(url.pathname.slice("/files/".length));
      await env.FILES.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get("content-type") ?? "application/octet-stream",
        },
      });
      return Response.json({ key, stored: true });
    }
    if (url.pathname.startsWith("/files/") && request.method === "GET") {
      const key = decodeURIComponent(url.pathname.slice("/files/".length));
      const object = await env.FILES.get(key);
      if (!object) {
        return new Response("not found", { status: 404 });
      }
      return new Response(object.body, {
        headers: {
          "content-type":
            object.httpMetadata?.contentType ?? "application/octet-stream",
        },
      });
    }
    // Write to the D1 database so the preview panel has data to show.
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS visits (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, url TEXT NOT NULL)"
    ).run();
    await env.DB.prepare("INSERT INTO visits (ts, url) VALUES (?, ?)")
      .bind(new Date().toISOString(), request.url)
      .run();
    const { results } = await env.DB.prepare(
      "SELECT * FROM visits ORDER BY id DESC LIMIT 10"
    ).all();
    const name = new URL(request.url).searchParams.get("name") ?? "default";
    const id = env.COUNTER.idFromName(name);
    const counter = await env.COUNTER.get(id).fetch(request);
    const counterBody = await counter.json();
    return Response.json({ ...counterBody, visits: results });
  },
};
