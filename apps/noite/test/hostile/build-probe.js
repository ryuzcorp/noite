// Build-time probe: attempts every exfiltration a tenant build script can
// try. Each attempt records { ok: false } when the sandbox held (EACCES,
// missing env, rejected fetch) and { ok: true, detail } when it leaked.
// The deploy only passes when every secret/file/network probe failed.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

const out = {};
const deny = (name, fn) => {
  try {
    const detail = fn();
    out[name] = { detail: String(detail).slice(0, 200), ok: true };
  } catch (error) {
    out[name] = { detail: String(error).slice(0, 200), ok: false };
  }
};
const denyAsync = async (name, fn) => {
  try {
    const detail = await fn();
    out[name] = { detail: String(detail).slice(0, 200), ok: true };
  } catch (error) {
    out[name] = { detail: String(error).slice(0, 200), ok: false };
  }
};

for (const key of [
  "RUNNER_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "BETTER_AUTH_SECRET",
]) {
  out[`env:${key}`] = process.env[key]
    ? { detail: "present", ok: true }
    : { detail: "absent", ok: false };
}
deny(
  "read:/data/noite.sqlite",
  () => readFileSync("/data/noite.sqlite", "utf-8").length
);
deny("read:/proc/self/environ:secrets", () => {
  const raw = readFileSync("/proc/self/environ", "utf-8");
  const hit = [
    "RUNNER_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "BETTER_AUTH_SECRET",
  ].filter((k) => raw.includes(k));
  if (hit.length > 0) {
    return `leaked ${hit.join(",")}`;
  }
  throw new Error("no platform secrets in environ");
});
// Real targets only: a probe at an address nothing listens on "fails" with
// or without isolation and proves nothing. Builds run in the one Noite
// container, so the runner, the control node's internal port and Caddy's
// admin API are all on loopback; the bundled store resolves by name.
await Promise.all(
  [
    ["fetch:runner-loopback", "http://127.0.0.1:8080/health"],
    ["fetch:rustfs", "http://rustfs:9000/"],
    ["fetch:control-operator", "http://127.0.0.1:8091/state"],
    ["fetch:caddy-admin", "http://127.0.0.1:2019/config/"],
  ].map(([name, target]) =>
    denyAsync(name, async () => {
      const res = await fetch(target, { signal: AbortSignal.timeout(3000) });
      return `status ${res.status}`;
    })
  )
);
await denyAsync("fetch:metadata", async () => {
  const res = await fetch("http://169.254.169.254/");
  return `status ${res.status}`;
});

mkdirSync("dist", { recursive: true });
// Placeholder for the Worker import: in multi-tenant mode without scoped
// credentials the release step is skipped, and release-probe.js never runs.
writeFileSync(
  "dist/release-probe.json",
  JSON.stringify({ phase: "release", probes: {}, skipped: true }, null, 2)
);
writeFileSync(
  "dist/probe.json",
  JSON.stringify({ phase: "build", probes: out }, null, 2)
);
appendFileSync("dist/probe.log", `build probes ${JSON.stringify(out)}\n`);
console.log(`hostile build probes: ${JSON.stringify(out)}`);
