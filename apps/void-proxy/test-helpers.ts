// Shared fakes for the void-proxy tests: in-memory KV, a scripted fake SMTP
// server over real TCP (Bun.listen), an in-memory canned socket pair, and a
// Bun.connect-backed `SocketConnect` for TCP integration tests.
/* oxlint-disable eslint/require-await -- test doubles mirror async platform interfaces */
/* oxlint-disable eslint/max-classes-per-file -- two fakes (KV, socket) share this helper module */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- test fakes shuttle untyped JSON bodies */
import type {
  EdgeCache,
  Env,
  IsrKvNamespace,
  MailKvNamespace,
  ProxyDeps,
  ProxySocket,
  SocketConnect,
} from "./src/env.ts";
import { handleFetch } from "./worker.ts";

export const TEST_PROJECT_ID = "proj_test123";
export const TEST_TOKEN = "test-token-0123456789abcdef";
export const TEST_SLUG = "myapp";
export const TEST_DOMAIN = "mail.example.com";
export const TEST_FROM = `${TEST_SLUG}+noreply@${TEST_DOMAIN}`;

export const makeEnv = (overrides: Partial<Env> = {}): Env => ({
  __PROJECT_ID: TEST_PROJECT_ID,
  __VOID_EMAIL_DOMAIN: TEST_DOMAIN,
  __VOID_PROJECT_SLUG: TEST_SLUG,
  __VOID_PROXY_TOKEN: TEST_TOKEN,
  ...overrides,
});

/** POST a JSON body (with valid auth unless overridden) and parse the reply. */
export const post = async (
  path: string,
  body: Record<string, unknown>,
  env: Env,
  deps: ProxyDeps = {}
): Promise<{ status: number; json: unknown }> => {
  const request = new Request(`https://proxy${path}`, {
    body: JSON.stringify({
      aiToken: TEST_TOKEN,
      projectId: TEST_PROJECT_ID,
      ...body,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const response = await handleFetch(request, env, deps);

  return { json: await response.json(), status: response.status };
};

/** In-memory KV implementing both proxy KV surfaces, with real pagination. */
export class FakeKv implements IsrKvNamespace, MailKvNamespace {
  readonly store = new Map<string, string>();
  readonly puts: { key: string; ttl?: number }[] = [];
  readonly deletes: string[] = [];
  fail: { list?: boolean; get?: boolean; put?: boolean; delete?: boolean } = {};

  async get(key: string): Promise<string | null> {
    if (this.fail.get) {
      throw new Error("kv boom");
    }

    return this.store.get(key) ?? null;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void> {
    if (this.fail.put) {
      throw new Error("kv boom");
    }

    this.store.set(key, value);
    this.puts.push({ key, ttl: options?.expirationTtl });
  }

  async delete(key: string): Promise<void> {
    if (this.fail.delete) {
      throw new Error("kv boom");
    }

    this.store.delete(key);
    this.deletes.push(key);
  }

  async list(options: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }> {
    if (this.fail.list) {
      throw new Error("kv boom");
    }

    const prefix = options.prefix ?? "";
    const limit = options.limit ?? 1000;

    const names = [...this.store.keys()]
      .filter((k) => k.startsWith(prefix))
      .toSorted();

    // Keyset cursor like the real platforms (celld encodes the last key name):
    // deleting already-returned keys never shifts the resume point.
    const decoded: unknown = options.cursor
      ? JSON.parse(Buffer.from(options.cursor, "base64").toString())
      : "";

    const after = typeof decoded === "string" ? decoded : "";

    const start = names.findIndex((n) => n > after);
    const rest = start === -1 ? [] : names.slice(start, start + limit);
    const done = start === -1 || start + rest.length >= names.length;

    return {
      cursor: done
        ? undefined
        : Buffer.from(JSON.stringify(rest.at(-1))).toString("base64"),
      keys: rest.map((name) => ({ name })),
      list_complete: done,
    };
  }
}

/** In-memory edge cache recording every deleted URL, with a failing mode. */
export class FakeCache implements EdgeCache {
  readonly deletes: string[] = [];
  failDelete = false;

  async delete(url: string): Promise<boolean> {
    if (this.failDelete) {
      throw new Error("cache boom");
    }

    this.deletes.push(url);

    return true;
  }
}

/** Build a minimal MIME message (CRLF) with a matching `From:` header. */
export const buildMime = (
  from: string,
  extraHeaders: string[] = [],
  body = "hello"
): string => {
  const lines = [
    `From: ${from}`,
    "To: someone@example.org",
    "Subject: test message",
    "Message-ID: <test-1@example.org>",
    "Content-Type: text/plain; charset=utf-8",
    ...extraHeaders,
    "",
    body,
    "",
  ];

  return lines.join("\r\n");
};

export const mimeBase64 = (mime: string): string =>
  Buffer.from(mime, "utf-8").toString("base64");

// ---------------------------------------------------------------------------
// Canned in-memory socket (unit-tests the SMTP state machine without TCP).
// ---------------------------------------------------------------------------

export interface CannedSocketShared {
  writes: string[];
  startTlsCalls: ({ expectedServerHostname?: string } | undefined)[];
  closed: boolean;
}

/** A `ProxySocket` fed from canned reply lines, chunked to stress the reader. */
export class CannedSocket implements ProxySocket {
  readonly shared: CannedSocketShared;
  upgradedTo: CannedSocket | null = null;
  private readonly payload: Uint8Array;

  constructor(replyLines: string[], shared?: CannedSocketShared) {
    this.shared = shared ?? { closed: false, startTlsCalls: [], writes: [] };
    // Replies are re-chunked on read so multi-line replies arrive split mid-line.
    this.payload = new TextEncoder().encode(
      replyLines.map((l) => `${l}\r\n`).join("")
    );
  }

  get readable(): ReadableStream<Uint8Array> {
    const { payload } = this;
    let offset = 0;

    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= payload.byteLength) {
          controller.close();

          return;
        }

        // Odd chunk sizes split lines and CRLF pairs mid-sequence.
        const size = 1 + ((offset * 2_654_435_761) % 11);
        controller.enqueue(payload.slice(offset, offset + size));
        offset += size;
      },
    });
  }

  get writable(): WritableStream<Uint8Array> {
    const { shared } = this;
    const decoder = new TextDecoder();

    return new WritableStream<Uint8Array>({
      write(chunk) {
        shared.writes.push(decoder.decode(chunk, { stream: true }));
      },
    });
  }

  close(): Promise<void> {
    this.shared.closed = true;

    return Promise.resolve();
  }

  startTls(options?: { expectedServerHostname?: string }): ProxySocket {
    this.shared.startTlsCalls.push(options);

    if (!this.upgradedTo) {
      throw new Error("canned socket has no upgrade target");
    }

    return this.upgradedTo;
  }
}

/** A `SocketConnect` returning canned sockets; records connect arguments. */
export const cannedSocketConnect =
  (
    socket: CannedSocket,
    seen: { hostname: string; port: number; secureTransport?: string }[] = []
  ): SocketConnect =>
  (address, options) => {
    seen.push({ ...address, secureTransport: options?.secureTransport });

    return socket;
  };

// ---------------------------------------------------------------------------
// Fake SMTP server over real TCP.
// ---------------------------------------------------------------------------

export interface FakeSmtpOptions {
  /** Full EHLO reply lines (default advertises AUTH PLAIN LOGIN). */
  ehloLines?: string[];
  /** How AUTH PLAIN behaves. Default "ok". */
  authPlain?: "ok" | "challenge" | "fail";
  /** How AUTH LOGIN behaves. Default "ok". */
  authLogin?: "ok" | "fail";
  /** Reply to MAIL FROM. Default "250 2.1.0 ok". */
  mailReply?: string;
  /** Per-recipient (lower-cased) RCPT replies. Default "250 2.1.5 ok". */
  rcptReply?: (recipient: string) => string;
  /** Reply to the DATA command. Default "354 end with .". */
  dataReply?: string;
  /** Reply after the terminating dot. "hang" never replies (timeout test). */
  dataEndReply?: string | "hang";
  /** If true, destroy the connection instead of answering DATA end. */
  dropAfterData?: boolean;
}

export interface FakeSmtpServer {
  port: number;
  /** Command lines received outside DATA (upper-cased verb + args). */
  commands: string[];
  /** Raw DATA payloads as received (dot-stuffed, CRLF), one per message. */
  dataPayloads: string[];
  connections: number;
  /**
   * Resolves when a connection closes. Data events precede close, so awaiting
   * this before asserting on `commands` is deterministic (no sleeps).
   */
  waitForClose: () => Promise<void>;
  stop: () => void;
}

export const startFakeSmtpServer = (
  options: FakeSmtpOptions = {}
): FakeSmtpServer => {
  const ehloLines = options.ehloLines ?? [
    "250-fake ESMTP",
    "250 AUTH PLAIN LOGIN",
  ];

  const authPlain = options.authPlain ?? "ok";
  const authLogin = options.authLogin ?? "ok";
  const mailReply = options.mailReply ?? "250 2.1.0 ok";
  const rcptReply = options.rcptReply ?? (() => "250 2.1.5 ok");
  const dataReply = options.dataReply ?? "354 end data with <CR><LF>.<CR><LF>";
  const dataEndReply = options.dataEndReply ?? "250 2.0.0 queued as fake-123";

  const commands: string[] = [];
  const dataPayloads: string[] = [];
  let connections = 0;
  let closedCount = 0;
  const closeWaiters: (() => void)[] = [];

  interface SmtpConnState {
    buffer: string;
    inData: boolean;
    dataLines: string[];
    /** Pending AUTH challenge: the next bare line answers it. */
    auth: null | { mech: "plain-challenge" } | { mech: "login"; step: 1 | 2 };
  }

  type FakeSocket = Bun.Socket<SmtpConnState>;

  /** Answer one DATA-phase line. Returns false when the connection is gone. */
  const answerDataLine = (
    socket: FakeSocket,
    state: SmtpConnState,
    line: string
  ): boolean => {
    if (line !== ".") {
      state.dataLines.push(line);

      return true;
    }

    state.inData = false;
    dataPayloads.push(state.dataLines.join("\r\n"));
    state.dataLines = [];

    if (options.dropAfterData) {
      socket.end();

      return false;
    }

    if (dataEndReply !== "hang") {
      socket.write(`${dataEndReply}\r\n`);
    }

    return true;
  };

  /** Answer a bare line continuing an AUTH challenge (credentials redacted). */
  const answerAuthLine = (socket: FakeSocket, state: SmtpConnState): void => {
    commands.push("AUTH-CONTINUE ****");
    const pending = state.auth;
    state.auth = null;

    if (!pending) {
      return;
    }

    if (pending.mech === "plain-challenge") {
      socket.write(
        authPlain === "ok" ? "235 2.7.0 ok\r\n" : "535 5.7.8 auth failed\r\n"
      );

      return;
    }

    if (pending.step === 1) {
      if (authLogin === "ok") {
        socket.write("334 UGFzc3dvcmQ6\r\n");
        state.auth = { mech: "login", step: 2 };
      } else {
        socket.write("535 5.7.8 auth failed\r\n");
      }

      return;
    }

    socket.write(
      authLogin === "ok" ? "235 2.7.0 ok\r\n" : "535 5.7.8 auth failed\r\n"
    );
  };

  const answerAuthCommand = (
    socket: FakeSocket,
    state: SmtpConnState,
    args: string
  ): void => {
    if (args.toUpperCase().startsWith("PLAIN")) {
      const initial = args.slice("PLAIN".length).trim();

      if (authPlain === "fail") {
        socket.write("535 5.7.8 auth failed\r\n");
      } else if (initial.length > 0 && authPlain === "ok") {
        socket.write("235 2.7.0 ok\r\n");
      } else if (authPlain === "challenge" || initial.length === 0) {
        socket.write("334 \r\n");
        state.auth = { mech: "plain-challenge" };
      } else {
        socket.write("535 5.7.8 auth failed\r\n");
      }

      return;
    }

    if (args.toUpperCase() === "LOGIN") {
      if (authLogin === "fail") {
        socket.write("535 5.7.8 auth failed\r\n");
      } else {
        socket.write("334 VXNlcm5hbWU6\r\n");
        state.auth = { mech: "login", step: 1 };
      }

      return;
    }

    socket.write("504 unrecognized mechanism\r\n");
  };

  const answerCommand = (
    socket: FakeSocket,
    state: SmtpConnState,
    line: string
  ): void => {
    const [verbRaw, ...rest] = line.split(" ");
    const verb = (verbRaw ?? "").toUpperCase();
    const args = rest.join(" ");
    commands.push(
      verb === "AUTH" && args ? `AUTH ${args.split(" ")[0]}` : line
    );

    switch (verb) {
      case "EHLO":
      case "HELO": {
        socket.write(`${ehloLines.join("\r\n")}\r\n`);
        break;
      }

      case "AUTH": {
        answerAuthCommand(socket, state, args);
        break;
      }

      case "MAIL": {
        socket.write(`${mailReply}\r\n`);
        break;
      }

      case "RCPT": {
        const match = /TO:\s*<(?<addr>[^>]*)>/iu.exec(args);
        socket.write(
          `${rcptReply((match?.groups?.addr ?? "").toLowerCase())}\r\n`
        );
        break;
      }

      case "DATA": {
        if (dataReply.startsWith("354")) {
          state.inData = true;
          state.dataLines = [];
        }

        socket.write(`${dataReply}\r\n`);
        break;
      }

      case "RSET": {
        state.inData = false;
        state.dataLines = [];
        socket.write("250 2.0.0 ok\r\n");
        break;
      }

      case "QUIT": {
        socket.write("221 2.0.0 bye\r\n");
        socket.end();
        break;
      }

      case "NOOP": {
        socket.write("250 2.0.0 ok\r\n");
        break;
      }

      default: {
        socket.write("502 5.5.2 command not implemented\r\n");
        break;
      }
    }
  };

  const listener = Bun.listen<SmtpConnState>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      close() {
        closedCount += 1;

        while (closeWaiters.length > 0) {
          closeWaiters.shift()?.();
        }
      },
      data(socket, data) {
        const state = socket.data;
        state.buffer += data.toString("latin1");

        for (;;) {
          const end = state.buffer.indexOf("\r\n");

          if (end === -1) {
            return;
          }

          const line = state.buffer.slice(0, end);
          state.buffer = state.buffer.slice(end + 2);

          if (state.inData) {
            if (!answerDataLine(socket, state, line)) {
              return;
            }

            continue;
          }

          if (state.auth) {
            answerAuthLine(socket, state);

            continue;
          }

          answerCommand(socket, state, line);
        }
      },
      error() {
        // Socket errors end the connection; the client maps them to outcomes.
      },
      open(socket) {
        connections += 1;
        socket.data = { auth: null, buffer: "", dataLines: [], inData: false };
        socket.write("220 fake ESMTP ready\r\n");
      },
    },
  });

  return {
    commands,
    get connections() {
      return connections;
    },
    dataPayloads,
    port: listener.port,
    stop() {
      listener.stop();
    },
    waitForClose() {
      const seen = closedCount;

      // oxlint-disable-next-line promise/avoid-new -- the test resolves on the socket close event
      return new Promise<void>((resolve) => {
        const check = (): void => {
          if (closedCount > seen) {
            resolve();
          } else {
            closeWaiters.push(check);
          }
        };

        check();
      });
    },
  };
};

// ---------------------------------------------------------------------------
// Bun.connect-backed SocketConnect (TCP integration tests only).
// ---------------------------------------------------------------------------

/** Wrap `Bun.connect` in the proxy's `ProxySocket` interface. Test-only. */
export const bunSocketConnect =
  (): SocketConnect =>
  ({ hostname, port }, _options) => {
    interface Waiter {
      resolve: (r: { value: Uint8Array; done: boolean }) => void;
    }

    const chunks: Uint8Array[] = [];
    const waiters: Waiter[] = [];
    let ended = false;

    const drain = (): void => {
      let waiter = waiters.shift();

      while (waiter) {
        const chunk = chunks.shift();

        if (chunk) {
          waiter.resolve({ done: false, value: chunk });
        } else if (ended) {
          waiter.resolve({ done: true, value: new Uint8Array(0) });
        } else {
          waiters.unshift(waiter);

          return;
        }

        waiter = waiters.shift();
      }
    };

    const push = (value: Uint8Array | null): void => {
      if (value === null) {
        ended = true;
      } else {
        chunks.push(value);
      }

      drain();
    };

    const connected = Bun.connect({
      hostname,
      port,
      socket: {
        close() {
          push(null);
        },
        data(_socket, data) {
          push(
            new Uint8Array(
              data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength
              )
            )
          );
        },
        error() {
          push(null);
        },
      },
    });

    const readable = new ReadableStream<Uint8Array>({
      cancel() {
        ended = true;
      },
      pull(controller) {
        const chunk = chunks.shift();

        if (chunk) {
          controller.enqueue(chunk);

          return;
        }

        if (ended) {
          controller.close();

          return;
        }

        // oxlint-disable-next-line promise/avoid-new -- pull waits for the next socket chunk
        return new Promise<void>((resolve) => {
          waiters.push({
            resolve: ({ value, done }) => {
              if (done) {
                controller.close();
              } else {
                controller.enqueue(value);
              }

              resolve();
            },
          });
        });
      },
    });

    const writable = new WritableStream<Uint8Array>({
      async close() {
        // The socket closes separately via `close()`.
      },
      async write(chunk) {
        const socket = await connected;
        socket.write(chunk);
      },
    });

    return {
      async close() {
        const socket = await connected;
        socket.end();
      },
      readable,
      startTls() {
        throw new Error("bun test socket does not support startTls");
      },
      writable,
    };
  };
