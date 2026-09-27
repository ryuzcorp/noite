// Release-time probe: same exfiltration set as the build, run with the
// release command's scoped credentials. Must also see no platform secret.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const out = {};
for (const key of [
  "RUNNER_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "BETTER_AUTH_SECRET",
]) {
  out[`env:${key}`] = process.env[key]
    ? { detail: "present", ok: true }
    : { detail: "absent", ok: false };
}
try {
  out["read:/data/noite.sqlite"] = {
    detail: String(readFileSync("/data/noite.sqlite", "utf-8").length),
    ok: true,
  };
} catch (error) {
  out["read:/data/noite.sqlite"] = {
    detail: String(error).slice(0, 200),
    ok: false,
  };
}
try {
  const res = await fetch("http://127.0.0.1:8091/state");
  out["fetch:control-internal"] = { detail: `status ${res.status}`, ok: true };
} catch (error) {
  out["fetch:control-internal"] = {
    detail: String(error).slice(0, 200),
    ok: false,
  };
}
try {
  const prefix = process.env.NOITE_APP_PREFIX ?? "";
  out["scoped-prefix"] = { detail: prefix, ok: prefix.startsWith("fleets/") };
} catch (error) {
  out["scoped-prefix"] = { detail: String(error).slice(0, 200), ok: false };
}
writeFileSync(
  "dist/release-probe.json",
  JSON.stringify({ phase: "release", probes: out }, null, 2)
);
appendFileSync("dist/probe.log", `release probes ${JSON.stringify(out)}\n`);
console.log(`hostile release probes: ${JSON.stringify(out)}`);
