#!/usr/bin/env bun
/**
 * Storage-contract qualification for an S3-compatible store, run against
 * the bundled RustFS or any operator bucket:
 *
 *   S3_ENDPOINT=http://127.0.0.1:9000 NOITE_S3_BUCKET=qualify bun docker/qualify-store.ts
 *
 * Every check names the guarantee it exercises. A failure exits non-zero
 * and names the exact guarantee the store broke, with the repro. A store
 * that accepts a conditional header and ignores it fails loudly here
 * instead of losing a cell to two owners weeks later.
 *
 * What cello needs (docs/guarantees.md in the cello repo):
 * - conditional create: If-None-Match `*` fails when the object exists;
 * - conditional overwrite: If-Match fails on a stale token;
 * - exactly one winner when writers race a create (the fencing contract);
 * - read-after-write and list-after-write consistency (epoch GC lists);
 * - ranged reads with the right range and bytes;
 * - multipart upload at cello's 5 MiB threshold and plain deletes.
 * Versioning is informational only: cello fences on etags, not versions.
 *
 * `cello diagnose --bucket s3://NAME --endpoint URL` runs cello's own
 * four-write probe (create, reject-create, update, reject-stale); this
 * script is the rest of the contract an operator must re-run on a bump.
 */
import { createHash, createHmac } from "node:crypto";

const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:9000";
const accessKey = process.env.AWS_ACCESS_KEY_ID ?? "noiteaccess";

const secretKey =
  process.env.AWS_SECRET_ACCESS_KEY ?? "noitesecretnoitesecretnoite12";

const region = process.env.AWS_REGION ?? "us-east-1";
const bucket = process.env.NOITE_S3_BUCKET ?? "qualify";

const runId = `${Date.now().toString(36)}-${Math.floor(Math.random() * 0xff_ff)
  .toString(16)
  .padStart(4, "0")}`;

const prefix = `qualify/${runId}/`;
const key = (name: string): string => `${prefix}${name}`;

const text = (body: Uint8Array): string => new TextDecoder().decode(body);

const sha256Hex = (data: Uint8Array | string): string =>
  createHash("sha256").update(data).digest("hex");

const hmac = (keyBytes: Uint8Array | string, data: string): Uint8Array =>
  createHmac("sha256", keyBytes).update(data).digest();

const sign = (
  method: string,
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  payloadHash: string
) => {
  const now = new Date();
  const amzDate = `${now.toISOString().replaceAll(/[-:]/gu, "").slice(0, 15)}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const url = new URL(endpoint);

  const canonicalUri = `/${path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;

  const canonicalQuery = Object.keys(query)
    .toSorted()
    .map(
      (k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? "")}`
    )
    .join("&");

  const signedNames = ["host", "x-amz-content-sha256", "x-amz-date"];

  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedNames.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), "s3"),
    "aws4_request"
  );

  const signature = createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  return {
    ...headers,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedNames.join(";")}, Signature=${signature}`,
  };
};

interface S3Response {
  body: Uint8Array;
  headers: Headers;
  status: number;
}

const request = async (
  method: string,
  path: string,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
  body?: Uint8Array
): Promise<S3Response> => {
  const payloadHash = sha256Hex(body ?? "");
  const signed = sign(method, path, query, headers, payloadHash);
  const qs = new URLSearchParams(query).toString();
  const url = `${endpoint}/${path}${qs === "" ? "" : `?${qs}`}`;

  const res = await fetch(url, {
    method,
    headers: signed,
    body: body === undefined ? undefined : body,
  });

  return {
    status: res.status,
    headers: res.headers,
    body: new Uint8Array(await res.arrayBuffer()),
  };
};

const listKeys = (xml: string): string[] =>
  [...xml.matchAll(/<Key>(?<key>[^<]*)<\/Key>/gu)].map(
    (m) => m.groups?.key ?? ""
  );

const fail = (check: string, detail: string): never => {
  console.error(`FAIL ${check}: ${detail}`);
  process.exit(1);
};

const ok = (check: string, detail: string): void => {
  console.log(`ok ${check}: ${detail}`);
};

const etagOf = (res: S3Response): string => {
  const etag = res.headers.get("etag");

  if (etag === null || etag === "") {
    fail(
      "conditional-write token",
      "a successful PUT answered no ETag, so cello has no CAS token to fence the next write"
    );
  }

  return etag;
};

/* Setup: the bucket exists (created here when missing). */
{
  const res = await request("PUT", bucket);

  if (![200, 409].includes(res.status)) {
    fail(
      "bucket exists",
      `PUT /${bucket} answered ${res.status}: ${text(res.body).slice(0, 300)}`
    );
  }

  ok("bucket exists", `s3://${bucket} reachable at ${endpoint}`);
}

/* 1. Conditional create on an absent key applies and answers a token. */
const created = await request(
  "PUT",
  `${bucket}/${key("cas")}`,
  {},
  { "If-None-Match": "*", "Content-Type": "application/octet-stream" },
  new TextEncoder().encode("probe-create")
);

if (created.status !== 200) {
  fail(
    "conditional create",
    `PUT If-None-Match * on an absent key answered ${created.status}: ${text(created.body).slice(0, 300)}`
  );
}

const token = etagOf(created);

ok("conditional create", `If-None-Match * applied, etag ${token}`);

/* 2. The same create over the object must be rejected. */
const recreate = await request(
  "PUT",
  `${bucket}/${key("cas")}`,
  {},
  { "If-None-Match": "*" },
  new TextEncoder().encode("probe-recreate")
);

if (![412, 409].includes(recreate.status)) {
  fail(
    "reject-create",
    `the store overwrote an object although the write was conditional on it being absent (answered ${recreate.status}); two nodes can own one cell`
  );
}

ok(
  "reject-create",
  `second If-None-Match * answered ${recreate.status}, not applied`
);

/* 3. A conditional update carrying the current token applies. */
const updated = await request(
  "PUT",
  `${bucket}/${key("cas")}`,
  {},
  { "If-Match": token },
  new TextEncoder().encode("probe-update")
);

if (updated.status !== 200) {
  fail(
    "conditional overwrite",
    `PUT If-Match with the current token answered ${updated.status}: ${text(updated.body).slice(0, 300)}`
  );
}

const token2 = etagOf(updated);

ok("conditional overwrite", `If-Match applied, etag ${token} -> ${token2}`);

/* 4. The retired token is stale now, so the same update must be rejected. */
const stale = await request(
  "PUT",
  `${bucket}/${key("cas")}`,
  {},
  { "If-Match": token },
  new TextEncoder().encode("probe-stale")
);

if (![412, 409].includes(stale.status)) {
  fail(
    "reject-stale",
    `the store applied a conditional write with a stale token (answered ${stale.status}); the fencing contract itself is broken`
  );
}

ok("reject-stale", `stale If-Match answered ${stale.status}, not applied`);

/* 5. Racing creates: exactly one writer wins. */
{
  const racers = 16;
  const raceKey = key("race");

  const bodies = Array.from(
    { length: racers },
    (_, i) => `racer-${i}-${runId}`
  );

  const results = await Promise.all(
    bodies.map(async (b) => {
      const res = await request(
        "PUT",
        `${bucket}/${raceKey}`,
        {},
        { "If-None-Match": "*" },
        new TextEncoder().encode(b)
      );

      return { body: b, status: res.status };
    })
  );

  const winners = results.filter((r) => r.status === 200);
  const losers = results.filter((r) => [412, 409].includes(r.status));

  if (winners.length !== 1 || losers.length !== racers - 1) {
    fail(
      "single-winner race",
      `${racers} racing creates: ${winners.length} won (${winners.map((w) => w.status).join(",")}), ` +
        `${losers.length} cleanly lost; the store must let exactly one create win`
    );
  }

  const readback = await request("GET", `${bucket}/${raceKey}`);

  if (readback.status !== 200 || !bodies.includes(text(readback.body))) {
    fail(
      "single-winner race",
      `winner's bytes unreadable after the race (GET answered ${readback.status})`
    );
  }

  ok(
    "single-winner race",
    `${racers} racing creates: 1 won, ${racers - 1} rejected, winner readable`
  );
}

/* 6. Read-after-write: a GET after a PUT returns the bytes. */
{
  const want = `read-after-write-${runId}-`.padEnd(1024, "x");

  const put = await request(
    "PUT",
    `${bucket}/${key("raw")}`,
    {},
    {},
    new TextEncoder().encode(want)
  );

  if (put.status !== 200) {
    fail("read-after-write", `PUT answered ${put.status}`);
  }

  const got = await request("GET", `${bucket}/${key("raw")}`);

  if (got.status !== 200 || text(got.body) !== want) {
    fail(
      "read-after-write",
      `GET after PUT answered ${got.status} with ${got.body.length} bytes, want ${want.length} matching bytes`
    );
  }

  ok("read-after-write", "GET after PUT returned the written bytes");
}

/* 7. List-after-write: the listing includes the key immediately (no retry). */
{
  const listed = await request("GET", bucket, {
    "list-type": "2",
    prefix,
    "max-keys": "100",
  });

  if (listed.status !== 200) {
    fail("list-after-write", `ListObjectsV2 answered ${listed.status}`);
  }

  const keys = listKeys(text(listed.body));

  for (const name of ["cas", "race", "raw"]) {
    if (!keys.includes(`${prefix}${name}`)) {
      fail(
        "list-after-write",
        `listing right after the writes is missing ${prefix}${name}; epoch GC restores from listings and would lose cells`
      );
    }
  }

  ok("list-after-write", "listing immediately includes the written keys");
}

/* 8. Ranged reads: the requested range and bytes, three spellings. */
{
  const alphabet = Array.from({ length: 256 }, (_, i) =>
    String.fromCodePoint(65 + (i % 26))
  ).join("");

  const put = await request(
    "PUT",
    `${bucket}/${key("range")}`,
    {},
    {},
    new TextEncoder().encode(alphabet)
  );

  if (put.status !== 200) {
    fail("ranged read", `PUT answered ${put.status}`);
  }

  const cases: [string, string, string][] = [
    ["bytes=6-11", "GHIJKL", "bytes 6-11/256"],
    ["bytes=0-0", "A", "bytes 0-0/256"],
    ["bytes=-8", alphabet.slice(-8), "bytes 248-255/256"],
  ];

  const reads = await Promise.all(
    cases.map(async ([range, want, contentRange]) => ({
      contentRange,
      range,
      res: await request(
        "GET",
        `${bucket}/${key("range")}`,
        {},
        { Range: range }
      ),
      want,
    }))
  );

  for (const { contentRange, range, res, want } of reads) {
    if (
      res.status !== 206 ||
      text(res.body) !== want ||
      res.headers.get("content-range") !== contentRange
    ) {
      fail(
        "ranged read",
        `Range ${range} answered ${res.status} ` +
          `content-range ${res.headers.get("content-range") ?? "absent"} ` +
          `with ${res.body.length} bytes; want 206 ${contentRange} with ${want.length} bytes`
      );
    }
  }

  ok("ranged read", "bytes=6-11, bytes=0-0 and bytes=-8 all served exact");
}

/* 9. Multipart at cello's 5 MiB threshold, then abort of a second upload. */
{
  const partSize = 5 * 1024 * 1024;
  const partA = new Uint8Array(partSize).fill(0x61);
  const partB = new Uint8Array(7).fill(0x62);

  const begun = await request("POST", `${bucket}/${key("multipart")}`, {
    uploads: "",
  });

  const uploadId = /<UploadId>(?<id>[^<]*)<\/UploadId>/u.exec(text(begun.body))
    ?.groups?.id;

  if (begun.status !== 200 || !uploadId) {
    fail(
      "multipart upload",
      `CreateMultipartUpload answered ${begun.status}: ${text(begun.body).slice(0, 300)}`
    );
  }

  const etags: string[] = [];

  const parts: [number, Uint8Array][] = [
    [1, partA],
    [2, partB],
  ];

  const ups = await Promise.all(
    parts.map(([n, part]) =>
      request(
        "PUT",
        `${bucket}/${key("multipart")}`,
        { partNumber: String(n), uploadId },
        {},
        part
      )
    )
  );

  for (const [index, up] of ups.entries()) {
    if (up.status !== 200) {
      fail("multipart upload", `UploadPart ${index + 1} answered ${up.status}`);
    }

    etags.push(etagOf(up));
  }

  const completeBody = new TextEncoder().encode(
    `<CompleteMultipartUpload>${etags.map((e, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${e}</ETag></Part>`).join("")}</CompleteMultipartUpload>`
  );

  const done = await request(
    "POST",
    `${bucket}/${key("multipart")}`,
    { uploadId },
    {},
    completeBody
  );

  if (done.status !== 200) {
    fail(
      "multipart upload",
      `CompleteMultipartUpload answered ${done.status}: ${text(done.body).slice(0, 300)}`
    );
  }

  const got = await request("GET", `${bucket}/${key("multipart")}`);

  if (
    got.status !== 200 ||
    got.body.length !== partSize + 7 ||
    got.body[0] !== 0x61 ||
    got.body[partSize] !== 0x62
  ) {
    fail(
      "multipart upload",
      `completed object reads back ${got.body.length} bytes (want ${partSize + 7}) with wrong boundary bytes`
    );
  }

  const begun2 = await request("POST", `${bucket}/${key("multipart-abort")}`, {
    uploads: "",
  });

  const uploadId2 = /<UploadId>(?<id>[^<]*)<\/UploadId>/u.exec(
    text(begun2.body)
  )?.groups?.id;

  if (begun2.status !== 200 || !uploadId2) {
    fail(
      "multipart abort",
      `second CreateMultipartUpload answered ${begun2.status}`
    );
  }

  const aborted = await request(
    "DELETE",
    `${bucket}/${key("multipart-abort")}`,
    { uploadId: uploadId2 }
  );

  if (![200, 204].includes(aborted.status)) {
    fail("multipart abort", `AbortMultipartUpload answered ${aborted.status}`);
  }

  ok(
    "multipart upload",
    `${partSize + 7} bytes over 2 parts round-tripped; abort answered ${aborted.status}`
  );
}

/* 10. DeleteObject, then the key is gone. */
{
  const del = await request("DELETE", `${bucket}/${key("raw")}`);

  if (![200, 204].includes(del.status)) {
    fail("delete", `DELETE answered ${del.status}`);
  }

  const head = await request("HEAD", `${bucket}/${key("raw")}`);
  const got = await request("GET", `${bucket}/${key("raw")}`);

  if (head.status !== 404 || got.status !== 404) {
    fail(
      "delete",
      `after DELETE, HEAD answered ${head.status} and GET ${got.status}; want 404/404`
    );
  }

  ok("delete", "DELETE removed the key; HEAD and GET answer 404");
}
/* Informational only: cello fences on etags, never on versions. */

{
  const res = await request("GET", bucket, { versioning: "" });

  const status =
    /<Status>(?<status>[^<]*)<\/Status>/u.exec(text(res.body))?.groups
      ?.status ?? "unknown";

  ok("versioning (info)", `bucket versioning reports ${status}; not required`);
}

/* Cleanup: only keys under this run's prefix. */
{
  const listed = await request("GET", bucket, {
    "list-type": "2",
    prefix,
    "max-keys": "100",
  });

  if (listed.status === 200) {
    await Promise.all(
      listKeys(text(listed.body)).map((k) =>
        request("DELETE", `${bucket}/${k}`)
      )
    );
  }

  const again = await request("GET", bucket, {
    "list-type": "2",
    prefix,
    "max-keys": "100",
  });

  const leftovers = again.status === 200 ? listKeys(text(again.body)) : ["?"];

  if (leftovers.length !== 0) {
    fail("cleanup", `${leftovers.length} keys left under ${prefix}`);
  }

  ok("cleanup", `removed every key under ${prefix}`);
}

console.log(`\nstore qualified: ${endpoint} bucket ${bucket}`);
