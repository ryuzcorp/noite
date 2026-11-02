// /email/send: validation/caps/error codes, admission, KV idempotency, and the
// SMTP client (canned sockets plus real-TCP integration via Bun.listen).
/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- tests shuttle untyped JSON bodies and assert on parsed shapes */
import { describe, expect, test } from "bun:test";

import {
  bunSocketConnect,
  buildMime,
  CannedSocket,
  cannedSocketConnect,
  FakeKv,
  makeEnv,
  mimeBase64,
  post,
  startFakeSmtpServer,
  TEST_FROM,
} from "./test-helpers.ts";
import type { CannedSocketShared } from "./test-helpers.ts";
import type { Env, ProxySocket } from "./worker.ts";

const emailEnv = (kv: FakeKv, overrides: Partial<Env> = {}): Env =>
  makeEnv({
    MAIL_IDEMPOTENCY: kv,
    VOID_PROXY_EMAIL_ALLOWLIST: "@example.org",
    VOID_PROXY_SMTP_ALLOW_PLAINTEXT: "1",
    VOID_PROXY_SMTP_HOST: "smtp.example.com",
    VOID_PROXY_SMTP_MODE: "plain",
    ...overrides,
  });

const emailBody = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  from: TEST_FROM,
  mimeBase64: mimeBase64(buildMime(TEST_FROM)),
  recipients: ["a@example.org"],
  requestId: "req_test_1",
  ...overrides,
});

/** Deps whose SMTP connect explodes — validation tests must never dial out. */
const noDial = {
  connectSocket: () => {
    throw new Error("must not connect");
  },
};

const HAPPY_TRANSCRIPT = [
  "220 fake ready",
  "250-fake greets you",
  "250 AUTH PLAIN LOGIN",
  "250 2.1.0 ok",
  "250 2.1.5 ok",
  "354 go ahead",
  "250 2.0.0 queued as xyz-1",
];

describe("email capability gate", () => {
  test("no SMTP host is a 501", async () => {
    const { status, json } = await post("/email/send", emailBody(), makeEnv());
    expect(status).toBe(501);
    expect(json).toEqual({ error: "email not configured" });
  });
});

describe("email validation", () => {
  test.each(["", "x".repeat(129), "has space\tor\nnewline", "non-ascii-ü"])(
    "bad idempotency key %p is a 400 INVALID_TO",
    async (idempotencyKey) => {
      const { status, json } = await post(
        "/email/send",
        emailBody({ idempotencyKey }),
        emailEnv(new FakeKv()),
        noDial
      );

      expect(status).toBe(400);
      expect(json).toEqual({
        error: { code: "INVALID_TO", message: "invalid idempotency key" },
        ok: false,
      });
    }
  );

  test("missing from/mime/recipients is a 400 UPSTREAM_ERROR", async () => {
    for (const body of [
      { mimeBase64: "eA==", recipients: ["a@example.org"], requestId: "r1" },
      { from: TEST_FROM, mimeBase64: "eA==", requestId: "r1" },
      { from: TEST_FROM, recipients: ["a@example.org"], requestId: "r1" },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
      const { status, json } = await post(
        "/email/send",
        body,
        emailEnv(new FakeKv()),
        noDial
      );

      expect(status).toBe(400);
      expect(json).toEqual({
        error: { code: "UPSTREAM_ERROR", message: "invalid body" },
        ok: false,
      });
    }
  });

  test("over 50 recipients is a 413 INVALID_TO", async () => {
    const recipients = Array.from(
      { length: 51 },
      (_, i) => `u${i}@example.org`
    );

    const { status, json } = await post(
      "/email/send",
      emailBody({ recipients }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(413);
    expect(json).toEqual({
      error: {
        code: "INVALID_TO",
        message: "too many recipients (max 50, got 51)",
      },
      ok: false,
    });
  });

  test("sender over 320 chars is a 413 INVALID_FROM without echoing it", async () => {
    const from = `myapp+${"t".repeat(400)}@mail.example.com`;

    const { status, json } = await post(
      "/email/send",
      emailBody({ from }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(413);
    expect(json).toEqual({
      error: { code: "INVALID_FROM", message: "sender exceeds 320 characters" },
      ok: false,
    });
  });

  test("missing sender domain config fails closed with 502", async () => {
    const env = emailEnv(new FakeKv(), { __VOID_EMAIL_DOMAIN: "" });

    const { status, json } = await post(
      "/email/send",
      emailBody(),
      env,
      noDial
    );

    expect(status).toBe(502);
    expect(json).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "email sender domain is not configured",
      },
      ok: false,
    });
  });

  test("recipient over 320 chars is a 413 INVALID_TO", async () => {
    const { status, json } = await post(
      "/email/send",
      emailBody({ recipients: [`${"u".repeat(320)}@example.org`] }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(413);
    expect(json).toEqual({
      error: {
        code: "INVALID_TO",
        message: "recipient exceeds 320 characters",
      },
      ok: false,
    });
  });

  test("non-string recipients are skipped; none left is a 200 INVALID_TO", async () => {
    const { status, json } = await post(
      "/email/send",
      emailBody({ recipients: [42, null, "   "] }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(200);
    expect(json).toEqual({
      error: { code: "INVALID_TO", message: "no recipients" },
      ok: false,
    });
  });

  test("oversized base64 is a 413 MIME_ERROR before decoding", async () => {
    const { status, json } = await post(
      "/email/send",
      emailBody({ mimeBase64: "A".repeat(7_000_000) }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(413);
    expect(json).toMatchObject({ error: { code: "MIME_ERROR" }, ok: false });
  });

  test("base64 decoding over 5 MiB is a 413 MIME_ERROR", async () => {
    // 6990512 chars of "A" pass the pre-decode guard but decode to >5 MiB.
    const { status, json } = await post(
      "/email/send",
      emailBody({ mimeBase64: "A".repeat(6_990_512) }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(413);
    expect(json).toMatchObject({ error: { code: "MIME_ERROR" }, ok: false });
  });

  test("invalid base64 is a 400 MIME_ERROR", async () => {
    const { status, json } = await post(
      "/email/send",
      emailBody({ mimeBase64: "!!! not base64 !!!" }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(400);
    expect(json).toEqual({
      error: { code: "MIME_ERROR", message: "invalid base64 mime" },
      ok: false,
    });
  });

  test("custom headers over 16 KiB are a 413 MIME_ERROR", async () => {
    const mime = buildMime(TEST_FROM, [`X-Custom: ${"v".repeat(17_000)}`]);

    const { status, json } = await post(
      "/email/send",
      emailBody({ mimeBase64: mimeBase64(mime) }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(413);
    expect(json).toEqual({
      error: {
        code: "MIME_ERROR",
        message: "custom headers exceed the 16 KiB limit",
      },
      ok: false,
    });
  });

  test("sender off the configured domain is a 200 INVALID_FROM naming it", async () => {
    const from = "myapp+noreply@evil.example.net";
    const mime = buildMime(from);

    const { status, json } = await post(
      "/email/send",
      emailBody({ from, mimeBase64: mimeBase64(mime) }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(200);
    expect(json).toEqual({
      error: {
        code: "INVALID_FROM",
        message: "from address must use the configured domain mail.example.com",
      },
      ok: false,
    });
  });

  test("non-ASCII sender is a 403 INVALID_FROM", async () => {
    // Correct domain (so the domain pin passes) but a Kelvin sign (U+212A)
    // that would change under case folding.
    const from = "myapp+noreplyK@mail.example.com";

    const { status, json } = await post(
      "/email/send",
      emailBody({ from }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(403);
    expect(json).toEqual({
      error: {
        code: "INVALID_FROM",
        message: "from address must be printable ASCII",
      },
      ok: false,
    });
  });

  test("sender pinned to the app slug, not another tenant's", async () => {
    const from = "otherapp+noreply@mail.example.com";

    const { status, json } = await post(
      "/email/send",
      emailBody({ from, mimeBase64: mimeBase64(buildMime(from)) }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(200);
    expect(json).toEqual({
      error: {
        code: "INVALID_FROM",
        message: "from address must be <myapp>[+tag]@mail.example.com",
      },
      ok: false,
    });
  });

  test("missing slug config fails closed with 502", async () => {
    const env = emailEnv(new FakeKv(), { __VOID_PROJECT_SLUG: "" });

    const { status, json } = await post(
      "/email/send",
      emailBody(),
      env,
      noDial
    );

    expect(status).toBe(502);
    expect(json).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "email sender identity is not configured",
      },
      ok: false,
    });
  });

  test("MIME From mismatch is a 403 INVALID_FROM", async () => {
    const mime = buildMime("evil@mail.example.com");

    const { status, json } = await post(
      "/email/send",
      emailBody({ mimeBase64: mimeBase64(mime) }),
      emailEnv(new FakeKv()),
      noDial
    );

    expect(status).toBe(403);
    expect(json).toMatchObject({
      error: {
        code: "INVALID_FROM",
        message: expect.stringContaining("mime From must be") as string,
      },
      ok: false,
    });
  });

  test("missing or doubled MIME From is a 403", async () => {
    const noFrom = "To: a@example.org\r\nSubject: x\r\n\r\nbody\r\n";
    const twoFrom = `From: ${TEST_FROM}\r\nFrom: ${TEST_FROM}\r\n\r\nbody\r\n`;

    for (const mime of [noFrom, twoFrom]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
      const { status, json } = await post(
        "/email/send",
        emailBody({ mimeBase64: mimeBase64(mime) }),
        emailEnv(new FakeKv()),
        noDial
      );

      expect(status).toBe(403);
      expect(json).toMatchObject({
        error: { code: "INVALID_FROM" },
        ok: false,
      });
    }
  });

  test("missing idempotency KV is a 502", async () => {
    const env = emailEnv(new FakeKv());
    delete (env as { MAIL_IDEMPOTENCY?: unknown }).MAIL_IDEMPOTENCY;

    const { status, json } = await post(
      "/email/send",
      emailBody(),
      env,
      noDial
    );

    expect(status).toBe(502);
    expect(json).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message: "email idempotency store is not configured",
      },
      ok: false,
    });
  });

  test("KV read failure is a 503 admission error", async () => {
    const kv = new FakeKv();
    kv.fail.get = true;

    const { status, json } = await post(
      "/email/send",
      emailBody(),
      emailEnv(kv),
      noDial
    );

    expect(status).toBe(503);
    expect(json).toEqual({
      error: { code: "UPSTREAM_ERROR", message: "email admission unavailable" },
      ok: false,
    });
  });

  test("plain mode needs the operator plaintext allowance", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv, { VOID_PROXY_SMTP_ALLOW_PLAINTEXT: "0" });

    const { status, json } = await post(
      "/email/send",
      emailBody(),
      env,
      noDial
    );

    expect(status).toBe(502);
    expect(json).toEqual({
      error: {
        code: "UPSTREAM_ERROR",
        message:
          "email smtp plaintext mode requires the operator plaintext allowance",
      },
      ok: false,
    });
  });

  test("bad SMTP mode or port is a 502", async () => {
    for (const overrides of [
      { VOID_PROXY_SMTP_MODE: "ssl" },
      { VOID_PROXY_SMTP_PORT: "notaport" },
      { VOID_PROXY_SMTP_PORT: "99999" },
    ]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cases, each asserted before the next
      const { status, json } = await post(
        "/email/send",
        emailBody(),
        emailEnv(new FakeKv(), overrides),
        noDial
      );

      expect(status).toBe(502);
      expect(json).toMatchObject({
        error: { code: "UPSTREAM_ERROR" },
        ok: false,
      });
    }
  });
});

describe("email admission", () => {
  test("empty allowlist fails closed with per-recipient rejections", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv, { VOID_PROXY_EMAIL_ALLOWLIST: "" });

    const { status, json } = await post(
      "/email/send",
      emailBody({ recipients: ["a@example.org", "b@example.org"] }),
      env,
      noDial
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({
      deliveries: [
        {
          error: {
            code: "UNVERIFIED_DESTINATION",
            message: "recipient 'a@example.org' is not allowlisted",
          },
          ok: false,
          recipient: "a@example.org",
          state: "rejected",
        },
        {
          error: {
            code: "UNVERIFIED_DESTINATION",
            message: "recipient 'b@example.org' is not allowlisted",
          },
          ok: false,
          recipient: "b@example.org",
          state: "rejected",
        },
      ],
      ok: false,
      operationId: expect.any(String),
    });
  });

  test("exact and @domain allowlist entries admit; others reject", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const socket = new CannedSocket(
      [
        "220 fake ready",
        "250 fake greets",
        "250 2.1.0 ok",
        "250 2.1.5 ok",
        "250 2.1.5 ok",
        "354 go",
        "250 2.0.0 queued",
      ],
      shared
    );

    const env = emailEnv(kv, {
      VOID_PROXY_EMAIL_ALLOWLIST: "vip@example.com, @example.org",
    });

    const { status, json } = await post(
      "/email/send",
      emailBody({
        recipients: ["a@example.org", "vip@example.com", "nope@example.net"],
      }),
      env,
      { connectSocket: cannedSocketConnect(socket) }
    );

    expect(status).toBe(200);

    const body = json as {
      ok: boolean;
      deliveries: { recipient: string; ok: boolean }[];
    };

    expect(body.ok).toBe(false);
    expect(body.deliveries).toHaveLength(3);
    expect(body.deliveries.map((d) => [d.recipient, d.ok])).toEqual([
      ["a@example.org", true],
      ["vip@example.com", true],
      ["nope@example.net", false],
    ]);
    // Only admitted recipients reached RCPT.
    const wire = shared.writes.join("");
    expect(wire).toContain("RCPT TO:<a@example.org>");
    expect(wire).toContain("RCPT TO:<vip@example.com>");
    expect(wire).not.toContain("nope@example.net");
  });
});

describe("email idempotency", () => {
  test("repeat with the same key replays the identical outcome without redialing", async () => {
    const kv = new FakeKv();

    const seen: { hostname: string; port: number; secureTransport?: string }[] =
      [];

    const first = new CannedSocket(HAPPY_TRANSCRIPT);
    const env = emailEnv(kv);
    const deps = { connectSocket: cannedSocketConnect(first, seen) };
    const body = emailBody({ idempotencyKey: "key-1" });
    const r1 = await post("/email/send", body, env, deps);
    expect(r1.status).toBe(200);
    expect(r1.json).toMatchObject({ ok: true });
    const r2 = await post("/email/send", body, env, deps);
    expect(r2.status).toBe(200);
    expect(r2.json).toEqual(r1.json);
    expect(seen).toHaveLength(1);
    // Stored for 24 h under the operation key.
    expect(kv.puts).toHaveLength(1);
    expect(kv.puts[0]).toEqual({ key: "idemp/v1/key-1", ttl: 86_400 });
  });

  test("same key with a different body is a 409 conflict", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv);

    const deps = {
      connectSocket: cannedSocketConnect(new CannedSocket(HAPPY_TRANSCRIPT)),
    };

    const r1 = await post(
      "/email/send",
      emailBody({ idempotencyKey: "key-9" }),
      env,
      deps
    );

    expect(r1.json).toMatchObject({ ok: true });

    const r2 = await post(
      "/email/send",
      emailBody({ idempotencyKey: "key-9", recipients: ["other@example.org"] }),
      env,
      deps
    );

    expect(r2.status).toBe(409);
    expect(r2.json).toEqual({
      error: {
        code: "IDEMPOTENCY_CONFLICT",
        message: "idempotency key has different content",
      },
      ok: false,
    });
  });

  test("requestId doubles as the operation key when no idempotency key is sent", async () => {
    const kv = new FakeKv();

    const seen: { hostname: string; port: number; secureTransport?: string }[] =
      [];

    const env = emailEnv(kv);

    const deps = {
      connectSocket: cannedSocketConnect(
        new CannedSocket(HAPPY_TRANSCRIPT),
        seen
      ),
    };

    const r1 = await post(
      "/email/send",
      emailBody({ requestId: "req_abc" }),
      env,
      deps
    );

    expect(r1.json).toMatchObject({ ok: true });

    const r2 = await post(
      "/email/send",
      emailBody({ requestId: "req_abc" }),
      env,
      deps
    );

    expect(r2.json).toEqual(r1.json);
    expect(seen).toHaveLength(1);
    expect(kv.puts[0]?.key).toBe("idemp/v1/req_abc");
  });

  test("outcome-store failure still returns the send result (best effort)", async () => {
    const kv = new FakeKv();
    kv.fail.put = true;
    const env = emailEnv(kv);

    const deps = {
      connectSocket: cannedSocketConnect(new CannedSocket(HAPPY_TRANSCRIPT)),
    };

    const { status, json } = await post(
      "/email/send",
      emailBody({ idempotencyKey: "key-nostore" }),
      env,
      deps
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true });
  });

  test("replays cover partial outcomes too", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv, { VOID_PROXY_EMAIL_ALLOWLIST: "" });
    const body = emailBody({ idempotencyKey: "key-partial" });
    const r1 = await post("/email/send", body, env, noDial);
    expect(r1.json).toMatchObject({ ok: false });
    const r2 = await post("/email/send", body, env, noDial);
    expect(r2.json).toEqual(r1.json);
  });
});

describe("SMTP submission (canned sockets)", () => {
  test("plaintext happy path speaks full SMTP and dot-stuffs", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const transcript = [
      "220 fake ready",
      "250-fake greets you",
      "250 AUTH PLAIN LOGIN",
      "250 2.1.0 ok",
      "250 2.1.5 ok",
      "250 2.1.5 ok",
      "354 go ahead",
      "250 2.0.0 queued as xyz-9",
    ];

    const seen: { hostname: string; port: number; secureTransport?: string }[] =
      [];

    const env = emailEnv(kv);
    const mime = buildMime(TEST_FROM, [], "hello\r\n.leading dot");

    const { status, json } = await post(
      "/email/send",
      emailBody({
        mimeBase64: mimeBase64(mime),
        recipients: ["a@example.org", "b@example.org"],
      }),
      env,
      {
        connectSocket: cannedSocketConnect(
          new CannedSocket(transcript, shared),
          seen
        ),
      }
    );

    expect(status).toBe(200);
    expect(json).toMatchObject({
      ids: [
        {
          messageId: "250 2.0.0 queued as xyz-9",
          recipient: "a@example.org",
          state: "provider_accepted",
        },
        {
          messageId: "250 2.0.0 queued as xyz-9",
          recipient: "b@example.org",
          state: "provider_accepted",
        },
      ],
      ok: true,
      operationId: expect.any(String),
    });
    expect(seen).toEqual([
      { hostname: "smtp.example.com", port: 25, secureTransport: "off" },
    ]);
    const wire = shared.writes.join("");
    expect(wire).toContain("EHLO mail.example.com\r\n");
    expect(wire).toContain(`MAIL FROM:<${TEST_FROM}>\r\n`);
    expect(wire).toContain("RCPT TO:<a@example.org>\r\n");
    expect(wire).toContain("RCPT TO:<b@example.org>\r\n");
    expect(wire).toContain("DATA\r\n");
    // Dot-stuffed on the wire, terminator present, QUIT sent, socket closed.
    expect(wire).toContain("..leading dot");
    expect(wire).toContain("\r\n.\r\n");
    expect(wire).toContain("QUIT\r\n");
    expect(shared.closed).toBe(true);
  });

  test("AUTH PLAIN with initial response", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const env = emailEnv(kv, {
      VOID_PROXY_SMTP_PASSWORD: "pass",
      VOID_PROXY_SMTP_USERNAME: "user",
    });

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket(
          [
            "220 fake ready",
            "250-fake",
            "250 AUTH PLAIN LOGIN",
            "235 2.7.0 ok",
            "250 2.1.0 ok",
            "250 2.1.5 ok",
            "354 go",
            "250 queued",
          ],
          shared
        )
      ),
    });

    expect(json).toMatchObject({ ok: true });
    expect(shared.writes.join("")).toContain("AUTH PLAIN ");
    expect(shared.writes.join("")).not.toContain("AUTH LOGIN");
  });

  test("AUTH PLAIN challenge flow when the server 334s the initial response", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const env = emailEnv(kv, {
      VOID_PROXY_SMTP_PASSWORD: "pass",
      VOID_PROXY_SMTP_USERNAME: "user",
    });

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket(
          [
            "220 fake ready",
            "250 AUTH PLAIN LOGIN",
            "334 continue",
            "235 2.7.0 ok",
            "250 2.1.0 ok",
            "250 2.1.5 ok",
            "354 go",
            "250 queued",
          ],
          shared
        )
      ),
    });

    expect(json).toMatchObject({ ok: true });
  });

  test("AUTH falls back to LOGIN when PLAIN fails", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const env = emailEnv(kv, {
      VOID_PROXY_SMTP_PASSWORD: "pass",
      VOID_PROXY_SMTP_USERNAME: "user",
    });

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket(
          [
            "220 fake ready",
            "250 AUTH PLAIN LOGIN",
            "535 bad",
            "334 VXNlcm5hbWU6",
            "334 UGFzc3dvcmQ6",
            "235 ok",
            "250 2.1.0 ok",
            "250 2.1.5 ok",
            "354 go",
            "250 queued",
          ],
          shared
        )
      ),
    });

    expect(json).toMatchObject({ ok: true });
    const wire = shared.writes.join("");
    expect(wire).toContain("AUTH PLAIN ");
    expect(wire).toContain("AUTH LOGIN");
  });

  test("failed AUTH marks every recipient failed without sending", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const env = emailEnv(kv, {
      VOID_PROXY_SMTP_PASSWORD: "bad",
      VOID_PROXY_SMTP_USERNAME: "user",
    });

    const { status, json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket(
          ["220 fake ready", "250 AUTH PLAIN LOGIN", "535 bad", "535 bad"],
          shared
        )
      ),
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({
      deliveries: [
        {
          error: {
            code: "UPSTREAM_ERROR",
            message: "smtp authentication failed",
          },
          ok: false,
          recipient: "a@example.org",
          state: "failed",
        },
      ],
      ok: false,
    });
    expect(shared.writes.join("")).not.toContain("MAIL FROM");
  });

  test("STARTTLS upgrades the connection and re-issues EHLO", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const plain = new CannedSocket(
      ["220 fake ready", "250-fake", "250 STARTTLS", "220 ready for tls"],
      shared
    );

    const tls = new CannedSocket(
      [
        "250-fake tls",
        "250 AUTH PLAIN",
        "250 2.1.0 ok",
        "250 2.1.5 ok",
        "354 go",
        "250 queued",
      ],
      shared
    );

    plain.upgradedTo = tls;

    const seen: { hostname: string; port: number; secureTransport?: string }[] =
      [];

    const env = emailEnv(kv, { VOID_PROXY_SMTP_MODE: "starttls" });

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(plain, seen),
    });

    expect(json).toMatchObject({ ok: true });
    // `starttls` transport at connect (required for the upgrade below), then
    // an explicit upgrade (celld `startTls()` shape).
    expect(seen).toEqual([
      { hostname: "smtp.example.com", port: 587, secureTransport: "starttls" },
    ]);
    expect(shared.startTlsCalls).toEqual([
      { expectedServerHostname: "smtp.example.com" },
    ]);
    const wire = shared.writes.join("");
    expect(wire).toContain("STARTTLS");
    expect(wire.match(/EHLO /gu)).toHaveLength(2);
  });

  test("missing STARTTLS advertisement fails instead of falling back to plaintext", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv, { VOID_PROXY_SMTP_MODE: "starttls" });

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket(["220 fake ready", "250 fake"])
      ),
    });

    expect(json).toMatchObject({
      deliveries: [
        expect.objectContaining({
          error: {
            code: "UPSTREAM_ERROR",
            message: "smtp server does not offer STARTTLS",
          },
          ok: false,
        }),
      ],
      ok: false,
    });
  });

  test("implicit mode connects with TLS on", async () => {
    const kv = new FakeKv();

    const seen: { hostname: string; port: number; secureTransport?: string }[] =
      [];

    const env = emailEnv(kv, { VOID_PROXY_SMTP_MODE: "implicit" });

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket(HAPPY_TRANSCRIPT),
        seen
      ),
    });

    expect(json).toMatchObject({ ok: true });
    expect(seen).toEqual([
      { hostname: "smtp.example.com", port: 465, secureTransport: "on" },
    ]);
  });

  test("RCPT 5xx rejects one recipient; the rest still send", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const env = emailEnv(kv);

    const { json } = await post(
      "/email/send",
      emailBody({ recipients: ["a@example.org", "bad@example.org"] }),
      env,
      {
        connectSocket: cannedSocketConnect(
          new CannedSocket(
            [
              "220 fake ready",
              "250 fake",
              "250 2.1.0 ok",
              "250 2.1.5 ok",
              "550 5.1.1 no such user",
              "354 go",
              "250 queued",
            ],
            shared
          )
        ),
      }
    );

    expect(json).toMatchObject({
      deliveries: [
        { ok: true, recipient: "a@example.org", state: "provider_accepted" },
        {
          error: {
            code: "UNVERIFIED_DESTINATION",
            message: "550 5.1.1 no such user",
          },
          ok: false,
          recipient: "bad@example.org",
          state: "failed",
        },
      ],
      ok: false,
    });
    expect(shared.writes.join("")).toContain("DATA\r\n");
  });

  test("RCPT 4xx is a transient UPSTREAM_ERROR failure", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv);

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket([
          "220 fake ready",
          "250 fake",
          "250 2.1.0 ok",
          "421 4.4.2 try later",
        ])
      ),
    });

    expect(json).toMatchObject({
      deliveries: [
        {
          error: { code: "UPSTREAM_ERROR", message: "421 4.4.2 try later" },
          ok: false,
          state: "failed",
        },
      ],
      ok: false,
    });
  });

  test("no accepted RCPT means no DATA is sent", async () => {
    const kv = new FakeKv();

    const shared: CannedSocketShared = {
      closed: false,
      startTlsCalls: [],
      writes: [],
    };

    const env = emailEnv(kv);

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket(
          ["220 fake ready", "250 fake", "250 2.1.0 ok", "550 nope"],
          shared
        )
      ),
    });

    expect(json).toMatchObject({ ok: false });
    expect(shared.writes.join("")).not.toContain("DATA");
    expect(shared.writes.join("")).toContain("QUIT");
  });

  test("MAIL FROM rejection fails every recipient with the reply", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv);

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket([
          "220 fake ready",
          "250 fake",
          "553 5.1.8 sender rejected",
        ])
      ),
    });

    expect(json).toMatchObject({
      deliveries: [
        {
          error: {
            code: "UPSTREAM_ERROR",
            message: "553 5.1.8 sender rejected",
          },
          ok: false,
          state: "failed",
        },
      ],
      ok: false,
    });
  });

  test("DATA-end 5xx is a definite failure", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv);

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket([
          "220 fake ready",
          "250 fake",
          "250 2.1.0 ok",
          "250 2.1.5 ok",
          "354 go",
          "552 5.3.4 too big",
        ])
      ),
    });

    expect(json).toMatchObject({
      deliveries: [
        {
          error: {
            code: "UPSTREAM_ERROR",
            message: expect.stringContaining("552") as string,
          },
          ok: false,
          state: "failed",
        },
      ],
      ok: false,
    });
  });

  test("DATA-end timeout is outcome_unknown, never a silent success", async () => {
    const kv = new FakeKv();

    const hanging: ProxySocket = {
      close: () => Promise.resolve(),
      readable: new ReadableStream<Uint8Array>({
        pull() {
          // Never produces: the per-command timeout must fire.
        },
      }),
      startTls: () => {
        throw new Error("no tls");
      },
      writable: new WritableStream<Uint8Array>({
        write() {
          // Discarded: the hanging side never answers.
        },
      }),
    };

    // Greeting itself hangs: pre-DATA, so `failed` is accurate even here.
    const env = emailEnv(kv);

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: () => hanging,
      timeouts: { smtpCommandMs: 50, smtpConnectMs: 50 },
    });

    expect(json).toMatchObject({
      deliveries: [
        { error: { code: "UPSTREAM_ERROR" }, ok: false, state: "failed" },
      ],
      ok: false,
    });
  });

  test("disconnect after DATA leaves outcome_unknown", async () => {
    const kv = new FakeKv();
    // Transcript ends right after DATA: EOF while awaiting the end reply.
    const env = emailEnv(kv);

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: cannedSocketConnect(
        new CannedSocket([
          "220 fake ready",
          "250 fake",
          "250 2.1.0 ok",
          "250 2.1.5 ok",
          "354 go",
        ])
      ),
    });

    expect(json).toMatchObject({
      deliveries: [
        {
          error: { code: "OUTCOME_UNKNOWN" },
          ok: false,
          state: "outcome_unknown",
        },
      ],
      ok: false,
    });
  });

  test("connect failure fails every recipient without crashing", async () => {
    const kv = new FakeKv();
    const env = emailEnv(kv);

    const { json } = await post("/email/send", emailBody(), env, {
      connectSocket: () => {
        throw new Error("connection refused");
      },
    });

    expect(json).toMatchObject({
      deliveries: [
        { error: { code: "UPSTREAM_ERROR" }, ok: false, state: "failed" },
      ],
      ok: false,
    });
  });
});

describe("SMTP over real TCP", () => {
  test("full plaintext send against a fake server", async () => {
    const server = startFakeSmtpServer();

    try {
      const kv = new FakeKv();

      const env = emailEnv(kv, {
        VOID_PROXY_SMTP_HOST: "127.0.0.1",
        VOID_PROXY_SMTP_PORT: String(server.port),
      });

      const mime = buildMime(TEST_FROM, [], "hello\r\n.dot line");

      const { status, json } = await post(
        "/email/send",
        emailBody({
          mimeBase64: mimeBase64(mime),
          recipients: ["a@example.org", "B@EXAMPLE.ORG"],
        }),
        env,
        { connectSocket: bunSocketConnect() }
      );

      expect(status).toBe(200);
      expect(json).toMatchObject({
        ids: [
          {
            messageId: "250 2.0.0 queued as fake-123",
            recipient: "a@example.org",
          },
          {
            messageId: "250 2.0.0 queued as fake-123",
            recipient: "b@example.org",
          },
        ],
        ok: true,
      });
      expect(server.connections).toBe(1);
      await server.waitForClose();
      expect(server.commands[0]).toMatch(/^EHLO /u);
      expect(server.commands).toContain(`MAIL FROM:<${TEST_FROM}>`);
      expect(server.commands).toContain("RCPT TO:<a@example.org>");
      expect(server.commands).toContain("RCPT TO:<b@example.org>");
      expect(server.commands).toContain("DATA");
      expect(server.commands.at(-1)).toBe("QUIT");
      // Dot-stuffed payload arrived intact.
      expect(server.dataPayloads).toHaveLength(1);
      expect(server.dataPayloads[0]).toContain("..dot line");
      expect(server.dataPayloads[0]).toContain(`From: ${TEST_FROM}`);
    } finally {
      server.stop();
    }
  });

  test("AUTH PLAIN plus a partial RCPT reject over TCP", async () => {
    const server = startFakeSmtpServer({
      rcptReply: (rcpt) =>
        rcpt === "bad@example.org" ? "550 5.1.1 no such user" : "250 2.1.5 ok",
    });

    try {
      const kv = new FakeKv();

      const env = emailEnv(kv, {
        VOID_PROXY_SMTP_HOST: "127.0.0.1",
        VOID_PROXY_SMTP_PASSWORD: "pass",
        VOID_PROXY_SMTP_PORT: String(server.port),
        VOID_PROXY_SMTP_USERNAME: "user",
      });

      const { json } = await post(
        "/email/send",
        emailBody({ recipients: ["a@example.org", "bad@example.org"] }),
        env,
        { connectSocket: bunSocketConnect() }
      );

      expect(json).toMatchObject({
        deliveries: [
          { ok: true, recipient: "a@example.org" },
          {
            error: { code: "UNVERIFIED_DESTINATION" },
            ok: false,
            recipient: "bad@example.org",
          },
        ],
        ok: false,
      });
      expect(server.commands).toContain("AUTH PLAIN");
    } finally {
      server.stop();
    }
  });

  test("DATA-end hang over TCP resolves to outcome_unknown via the command timeout", async () => {
    const server = startFakeSmtpServer({ dataEndReply: "hang" });

    try {
      const kv = new FakeKv();

      const env = emailEnv(kv, {
        VOID_PROXY_SMTP_HOST: "127.0.0.1",
        VOID_PROXY_SMTP_PORT: String(server.port),
      });

      const { json } = await post("/email/send", emailBody(), env, {
        connectSocket: bunSocketConnect(),
        timeouts: { smtpCommandMs: 100, smtpConnectMs: 2000 },
      });

      expect(json).toMatchObject({
        deliveries: [
          {
            error: { code: "OUTCOME_UNKNOWN" },
            ok: false,
            state: "outcome_unknown",
          },
        ],
        ok: false,
      });
    } finally {
      server.stop();
    }
  });

  test("dropped connection after DATA resolves to outcome_unknown", async () => {
    const server = startFakeSmtpServer({ dropAfterData: true });

    try {
      const kv = new FakeKv();

      const env = emailEnv(kv, {
        VOID_PROXY_SMTP_HOST: "127.0.0.1",
        VOID_PROXY_SMTP_PORT: String(server.port),
      });

      const { json } = await post("/email/send", emailBody(), env, {
        connectSocket: bunSocketConnect(),
      });

      expect(json).toMatchObject({
        deliveries: [
          {
            error: { code: "OUTCOME_UNKNOWN" },
            ok: false,
            state: "outcome_unknown",
          },
        ],
        ok: false,
      });
    } finally {
      server.stop();
    }
  });
});
