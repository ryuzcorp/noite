// Release-time probe: same exfiltration set as the build, run with the
// release command's scoped credentials. Must also see no platform secret.
import { createHash, createHmac } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";

const out = {};

for (const key of ["RUNNER_TOKEN", "BETTER_AUTH_SECRET"]) {
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

// Scoped bucket keys (SPEC, Scoped credentials): the release holds a key
// for its own prefix only. Positive: its own prefix round-trips. Negative:
// the neighbour app, the environment prefix and the bucket root refuse
// with 403 — fail closed, so a 404 (allowed but missing) or a transport
// error counts as a leak, never as containment. Speaks S3 REST directly
// (the image ships no awscli); SigV4 over node:crypto, no dependencies.
const s3Endpoint = process.env.S3_ENDPOINT ?? "";
const s3Bucket = process.env.NOITE_S3_BUCKET ?? "";
const s3Region = process.env.AWS_REGION ?? "us-east-1";
const s3Access = process.env.AWS_ACCESS_KEY_ID ?? "";
const s3Secret = process.env.AWS_SECRET_ACCESS_KEY ?? "";

out["s3:scoped-key"] = {
  detail: `key ${s3Access.slice(0, 8)}…`,
  ok: s3Access.length > 0 && s3Secret.length > 0,
};

const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

const s3Sign = (method, uri, query, payloadHash, amz, stamp) => {
  const { host } = new URL(s3Endpoint);

  const canonical = [
    method,
    uri,
    query,
    `host:${host}\nx-amz-date:${amz}\n`,
    "host;x-amz-date",
    payloadHash,
  ].join("\n");

  const scope = `${stamp}/${s3Region}/s3/aws4_request`;

  const signing = hmac(
    hmac(hmac(hmac(`AWS4${s3Secret}`, stamp), s3Region), "s3"),
    "aws4_request"
  );

  const signature = hmac(
    signing,
    `AWS4-HMAC-SHA256\n${amz}\n${scope}\n${sha256hex(canonical)}`
  ).toString("hex");

  return `AWS4-HMAC-SHA256 Credential=${s3Access}/${scope}, SignedHeaders=host;x-amz-date, Signature=${signature}`;
};

const s3 = async (method, path, query, body = "") => {
  const payloadHash = sha256hex(body);
  const now = new Date();
  const amz = `${now.toISOString().replaceAll(/[-:.]/gu, "").slice(0, 15)}Z`;
  const stamp = amz.slice(0, 8);
  const url = `${s3Endpoint}${path}${query ? `?${query}` : ""}`;

  const options = {
    headers: {
      authorization: s3Sign(method, path, query, payloadHash, amz, stamp),
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amz,
    },
    method,
  };

  if (method === "PUT") {
    options.body = body;
  }

  const res = await fetch(url, options);
  const text = await res.text();

  return { status: res.status, text: text.slice(0, 200) };
};

const s3Denied = async (name, method, path, query, body) => {
  try {
    const res = await s3(method, path, query, body);
    out[name] =
      res.status === 403
        ? { detail: "denied 403", ok: false }
        : { detail: `status ${res.status} ${res.text}`, ok: true };
  } catch (error) {
    out[name] = { detail: `error ${String(error).slice(0, 200)}`, ok: true };
  }
};

if (out["s3:scoped-key"].ok) {
  try {
    const marker = `probe-${Date.now()}`;

    const put = await s3(
      "PUT",
      `/${s3Bucket}/fleets/hostile/release-s3-probe.txt`,
      "",
      marker
    );

    const get = await s3(
      "GET",
      `/${s3Bucket}/fleets/hostile/release-s3-probe.txt`,
      "",
      ""
    );

    await s3(
      "DELETE",
      `/${s3Bucket}/fleets/hostile/release-s3-probe.txt`,
      "",
      ""
    );
    out["s3:own-read-write"] =
      put.status === 200 && get.status === 200 && get.text === marker
        ? { detail: "round-trip ok", ok: true }
        : { detail: `put ${put.status} get ${get.status}`, ok: false };
  } catch (error) {
    out["s3:own-read-write"] = {
      detail: `error ${String(error).slice(0, 200)}`,
      ok: false,
    };
  }

  await s3Denied(
    "s3:cross-app-list",
    "GET",
    `/${s3Bucket}/`,
    "delimiter=%2F&list-type=2&prefix=fleets%2Fhostile-neighbour%2F",
    ""
  );
  await s3Denied(
    "s3:cross-app-write",
    "PUT",
    `/${s3Bucket}/fleets/hostile-neighbour/probe.txt`,
    "",
    "x"
  );
  await s3Denied(
    "s3:env-list",
    "GET",
    `/${s3Bucket}/`,
    "delimiter=%2F&list-type=2&prefix=envs%2Fhostile%2F",
    ""
  );
  await s3Denied(
    "s3:root-list",
    "GET",
    `/${s3Bucket}/`,
    "delimiter=%2F&list-type=2",
    ""
  );
}

writeFileSync(
  "dist/release-probe.json",
  JSON.stringify({ phase: "release", probes: out }, null, 2)
);

appendFileSync("dist/probe.log", `release probes ${JSON.stringify(out)}\n`);

console.log(`hostile release probes: ${JSON.stringify(out)}`);
