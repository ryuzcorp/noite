import * as Sentry from "@sentry/browser";

const res = await fetch("/api/greeting");

// SAFETY: the sample Worker answers /api/greeting with { greeting } (src/index.ts).
const { greeting } = (await res.json()) as { greeting: string };
const el = document.querySelector("#greeting");

if (el) {
  el.textContent = greeting;
}

// E2E hook (sentry.spec.ts): with `?dsn=<dsn>&boom=<token>` the page reports
// a real uncaught error to the DSN's project. The throw escapes inside a
// macrotask so Sentry's global handlers capture it as an unhandled error.
const params = new URLSearchParams(location.search);
const dsn = params.get("dsn");
const boom = params.get("boom");

if (dsn && boom) {
  Sentry.init({ dsn, release: "vite-sample@e2e" });
  const token = boom;
  setTimeout(() => {
    throw new Error(`e2e-boom-${token}`);
  }, 0);
}
