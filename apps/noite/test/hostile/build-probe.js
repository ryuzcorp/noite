// Build-time probe: attempts every exfiltration a tenant build script can
// try. Each attempt records { ok: false } when the sandbox held (EACCES,
// missing env, rejected fetch) and { ok: true, detail } when it leaked.
// The deploy only passes when every secret/file/network probe failed.
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
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
    ["fetch:control-operator", "http://127.0.0.1:8091/state"],
    ["fetch:caddy-admin", "http://127.0.0.1:2019/config/"],
  ].map(([name, target]) =>
    denyAsync(name, async () => {
      const res = await fetch(target, { signal: AbortSignal.timeout(3000) });

      return `status ${res.status}`;
    })
  )
);

// The store's unauthenticated surface answers 401/403 by design (Workers
// reach it too); only an answered request counts as a leak. The build uid
// is allowed the store's address for the release command's scoped key, so
// a refused connection here would prove nothing — the status does.
try {
  const res = await fetch("http://rustfs:9000/", {
    signal: AbortSignal.timeout(3000),
  });

  out["fetch:rustfs"] =
    res.status === 401 || res.status === 403
      ? { detail: `status ${res.status}`, ok: false }
      : { detail: `status ${res.status}`, ok: true };
} catch (error) {
  out["fetch:rustfs"] = { detail: String(error).slice(0, 200), ok: false };
}

await denyAsync("fetch:metadata", async () => {
  const res = await fetch("http://169.254.169.254/");

  return `status ${res.status}`;
});

// Cross-build isolation: derive this app's slug from the build cwd
// (/data/runner/builds/<slug>/<ts>/src), then try to read every *other*
// app's worktree and persistent build cache. Each app's builds run as their
// own uid, so those directories are owned 0700 by the other app and every
// read must fail; under the old single shared build uid they were readable.
deny("read:sibling-build-cache", () => {
  const parts = process.cwd().split("/");
  const buildsIndex = parts.indexOf("builds");
  const ownSlug = buildsIndex === -1 ? "" : parts[buildsIndex + 1];
  const seen = [];
  const readable = [];

  for (const top of ["cache", "builds"]) {
    const root = `/data/runner/${top}`;
    let slugs;

    try {
      slugs = readdirSync(root);
    } catch {
      continue;
    }

    for (const slug of slugs) {
      if (slug === ownSlug) {
        continue;
      }

      seen.push(`${top}/${slug}`);
      const dir = `${root}/${slug}`;
      let leaves;

      try {
        leaves = readdirSync(dir);
      } catch {
        // Not even listable by this uid: already isolated.
        continue;
      }

      for (const leaf of leaves) {
        const target = `${dir}/${leaf}`;

        try {
          readdirSync(target);
          readable.push(target);
        } catch {
          // EACCES: this app's uid cannot even enter it.
        }
      }
    }
  }

  if (readable.length > 0) {
    return `read ${readable.slice(0, 3).join(", ")}`;
  }

  throw new Error(`siblings=${seen.length} readable=0`);
});

// Per-fleet cgroups are the inverse probe: containment holds when every
// fleet group carries a positive `memory.max`, read by the sandboxed build
// itself from the shared anchor. The build runs in the runner's leaf
// (`.../noite/runner`), so the anchor is its parent; every sibling directory
// is a live tenant fleet. Throws (ok: false) when cgroups are inactive (no
// anchor) or a fleet runs uncapped.
try {
  const selfLine = readFileSync("/proc/self/cgroup", "utf-8")
    .split("\n")
    .find((line) => line.startsWith("0::"));

  const own = (selfLine ?? "").slice(3) || "/";

  const anchor =
    own === "/"
      ? "/sys/fs/cgroup/noite"
      : `/sys/fs/cgroup${own.replace(/\/runner$/u, "")}`;

  // Every cgroup dir also carries the kernel's own interface files
  // (`cgroup.procs`, `memory.stat`, …): only subdirectories are fleets.
  const fleets = readdirSync(anchor, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "runner")
    .map((entry) => entry.name);

  const caps = fleets.map((name) => {
    const max = Number(
      readFileSync(`${anchor}/${name}/memory.max`, "utf-8").trim()
    );

    if (!Number.isInteger(max) || max <= 0) {
      throw new Error(`${name} uncapped (${max})`);
    }

    return `${name}=${max}`;
  });

  if (caps.length === 0) {
    throw new Error("no sibling fleet group to prove containment");
  }

  out["cgroup:fleet-memory-max"] = {
    detail: `fleets=${caps.length} ${caps.slice(0, 3).join(" ")}`,
    ok: true,
  };
} catch (error) {
  out["cgroup:fleet-memory-max"] = {
    detail: String(error).slice(0, 200),
    ok: false,
  };
}

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
