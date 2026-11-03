/**
 * SMTP client over `cloudflare:sockets` (Noite transport; Void uses the
 * `send_email` binding instead).
 */

/* oxlint-disable eslint/max-classes-per-file -- the classes are the error taxonomy (one per failure kind) plus the SMTP line reader */

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-known-value-widening -- untyped-JSON I/O boundary: every handler validates untrusted bodies field-by-field, so typeof-narrowing and open dictionaries are the job, not slop */

import { encoder, errorMessage, sanitizeForLog } from "../auth.ts";
import type { ProxySocket, SocketConnect } from "../env.ts";

const SMTP_MAX_LINE_BYTES = 8192;
const SMTP_MAX_REPLY_LINES = 128;
const SMTP_MESSAGE_ID_MAX_CHARS = 128;
const SMTP_REPLY_TEXT_MAX_CHARS = 200;

export type SmtpMode = "starttls" | "implicit" | "plain";

/** `startTls()` requires the `starttls` transport; `off` cannot upgrade. */
const TRANSPORT_BY_MODE: Record<SmtpMode, "off" | "on" | "starttls"> = {
  implicit: "on",
  plain: "off",
  starttls: "starttls",
};

interface SmtpReply {
  code: number;
  /** Full reply text (all lines joined), for `messageId` and diagnostics. */
  text: string;
  /** Upper-cased EHLO extension keywords, for capability checks. */
  extensions: string[];
}

class SmtpError extends Error {
  readonly reply: SmtpReply | null;

  constructor(message: string, reply: SmtpReply | null = null) {
    super(message);
    this.reply = reply;
    this.name = "SmtpError";
  }
}

class SmtpTimeoutError extends Error {
  constructor() {
    super("smtp command timed out");
    this.name = "SmtpTimeoutError";
  }
}

const withTimeout = async <T>(
  ms: number,
  run: () => T | Promise<T>,
  onTimeout: () => Error
): Promise<T> => {
  const work = run();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      // oxlint-disable-next-line promise/avoid-new -- timeout leg of the command race
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};

/** Line reader over a socket stream with multi-line (250-…) reply parsing. */
class SmtpLineReader {
  private buffer = "";
  private readonly socketReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();

  constructor(socket: ProxySocket) {
    this.socketReader = socket.readable.getReader();
  }

  release(): void {
    this.socketReader.releaseLock();
  }

  async readLine(): Promise<string> {
    for (;;) {
      const end = this.buffer.indexOf("\r\n");

      if (end !== -1) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);

        return line;
      }

      if (this.buffer.length > SMTP_MAX_LINE_BYTES) {
        throw new SmtpError("smtp reply line too long");
      }

      // oxlint-disable-next-line eslint/no-await-in-loop -- a stream is read chunk by chunk, in order
      const { value, done } = await this.socketReader.read();

      if (done) {
        throw new SmtpError("smtp connection closed by the server");
      }

      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async readReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    let code = -1;

    for (let i = 0; i < SMTP_MAX_REPLY_LINES; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- multi-line replies arrive in order
      const line = await this.readLine();
      lines.push(line);
      const match = /^(?<code>\d{3})(?<sep>[ -])/u.exec(line);

      if (!match?.groups) {
        throw new SmtpError(
          `malformed smtp reply: ${sanitizeForLog(line, 80)}`
        );
      }

      const { code: codeText, sep } = match.groups;
      code = Number(codeText);

      if (sep === " ") {
        return {
          code,
          extensions: lines
            .slice(1)
            .map((l) => l.slice(4).trim().toUpperCase()),
          text: lines.join("\n"),
        };
      }
    }

    throw new SmtpError("smtp reply has too many lines");
  }
}

const base64Encode = (bytes: Uint8Array): string => {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary);
};

const DOT = 0x2e;
const CR = 0x0d;
const LF = 0x0a;

/**
 * Dot-stuff raw MIME for the DATA phase: every line starting with `.` gains an
 * extra dot, line ends are normalized to CRLF, and the output ends with CRLF so
 * the terminating `.` line can follow. Works on bytes so 8bit content (UTF-8
 * bodies, RFC 6532 headers) reaches the server byte for byte.
 */
const dotStuffForSmtp = (raw: Uint8Array): Uint8Array => {
  // Worst case every byte doubles (LF -> CRLF, `.` -> `..`), plus a final CRLF.
  const out = new Uint8Array(raw.byteLength * 2 + 2);
  let length = 0;
  let lineStart = true;

  const push = (byte: number): void => {
    out[length] = byte;
    length += 1;
  };

  for (const [index, byte] of raw.entries()) {
    if (byte === CR && raw[index + 1] === LF) {
      continue;
    }

    if (byte === LF) {
      push(CR);
      push(LF);
      lineStart = true;
      continue;
    }

    if (lineStart && byte === DOT) {
      push(DOT);
    }

    push(byte);
    lineStart = false;
  }

  if (!lineStart || length === 0) {
    push(CR);
    push(LF);
  }

  return out.subarray(0, length);
};

export interface SmtpSubmitInput {
  connect: SocketConnect;
  host: string;
  port: number;
  mode: SmtpMode;
  username: string | null;
  password: string;
  ehloName: string;
  from: string;
  recipients: string[];
  raw: Uint8Array;
  connectTimeoutMs: number;
  commandTimeoutMs: number;
}

export type SmtpRecipientOutcome =
  | { ok: true; messageId: string }
  | {
      ok: false;
      state: "failed" | "outcome_unknown";
      code: string;
      message: string;
    };

const smtpFailureText = (err: unknown, fallback: string): string => {
  if (err instanceof SmtpTimeoutError) {
    return "smtp request timed out";
  }

  if (err instanceof SmtpError) {
    return err.reply
      ? sanitizeForLog(err.reply.text, SMTP_REPLY_TEXT_MAX_CHARS)
      : sanitizeForLog(err.message, SMTP_REPLY_TEXT_MAX_CHARS);
  }

  return (
    sanitizeForLog(errorMessage(err), SMTP_REPLY_TEXT_MAX_CHARS) || fallback
  );
};

/** AUTH PLAIN, then AUTH LOGIN. Returns true on `235`. */
const smtpAuth = async (
  command: (
    line: string | null,
    expect: (code: number) => boolean
  ) => Promise<SmtpReply>,
  extensions: string[],
  username: string,
  password: string
): Promise<boolean> => {
  const authLine = extensions.find(
    (e) => e === "AUTH" || e.startsWith("AUTH ")
  );

  const mechanisms = authLine ? authLine.slice(4).trim().split(/\s+/u) : [];

  const offers = (mech: string): boolean =>
    mechanisms.length === 0 || mechanisms.includes(mech);

  if (offers("PLAIN")) {
    const initial = base64Encode(encoder.encode(`\0${username}\0${password}`));

    try {
      await command(`AUTH PLAIN ${initial}`, (code) => code === 235);

      return true;
    } catch (error) {
      // Some servers reject the initial response but accept the challenge flow.
      if (!(error instanceof SmtpError) || error.reply === null) {
        throw error;
      }

      if (error.reply.code === 334) {
        try {
          await command(initial, (code) => code === 235);

          return true;
        } catch {
          // Fall through to LOGIN below.
        }
      } else {
        // Fall through to LOGIN below.
      }
    }
  }

  if (offers("LOGIN")) {
    try {
      await command("AUTH LOGIN", (code) => code === 334);
      await command(
        base64Encode(encoder.encode(username)),
        (code) => code === 334
      );
      await command(
        base64Encode(encoder.encode(password)),
        (code) => code === 235
      );

      return true;
    } catch {
      return false;
    }
  }

  return false;
};

/**
 * Submit one message in a single SMTP transaction. Returns a per-recipient
 * outcome for every recipient. Throws only on internal misuse; transport
 * failures become per-recipient `failed`/`outcome_unknown` outcomes.
 */
export const smtpSubmit = async (
  input: SmtpSubmitInput
): Promise<Map<string, SmtpRecipientOutcome>> => {
  const outcomes = new Map<string, SmtpRecipientOutcome>();

  const failAll = (
    state: "failed" | "outcome_unknown",
    code: string,
    message: string
  ): void => {
    for (const r of input.recipients) {
      if (!outcomes.has(r)) {
        outcomes.set(r, { code, message, ok: false, state });
      }
    }
  };

  let socket: ProxySocket | null = null;
  let reader: SmtpLineReader | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  try {
    socket = await withTimeout(
      input.connectTimeoutMs,
      () =>
        input.connect(
          { hostname: input.host, port: input.port },
          { secureTransport: TRANSPORT_BY_MODE[input.mode] }
        ),
      () => new SmtpTimeoutError()
    );
    // NOTE: `starttls` mode connects with the `starttls` transport (plaintext
    // until the upgrade) because `startTls()` requires it; the TLS upgrade
    // happens after the STARTTLS command below.
    writer = socket.writable.getWriter();
    reader = new SmtpLineReader(socket);

    const command = (
      line: string | null,
      expect: (code: number) => boolean
    ): Promise<SmtpReply> =>
      withTimeout(
        input.commandTimeoutMs,
        async () => {
          const activeWriter = writer;
          const activeReader = reader;

          if (activeWriter === null || activeReader === null) {
            throw new SmtpError("smtp connection closed");
          }

          if (line !== null) {
            // Defense in depth: the caller validates every address before
            // submission, but no command line may ever carry a line break —
            // refuse before the write, never after.
            if (line.includes("\r") || line.includes("\n")) {
              throw new SmtpError(
                "smtp command argument contains a line break"
              );
            }

            await activeWriter.write(encoder.encode(`${line}\r\n`));
          }

          const reply = await activeReader.readReply();

          if (!expect(reply.code)) {
            throw new SmtpError(
              `smtp command failed: ${sanitizeForLog(reply.text, 120)}`,
              reply
            );
          }

          return reply;
        },
        () => new SmtpTimeoutError()
      );

    await command(null, (code) => code === 220);

    const greetingEhlo = await command(
      `EHLO ${input.ehloName}`,
      (code) => code === 250
    );

    const maybeUpgradeToTls = async (
      plainEhlo: SmtpReply
    ): Promise<SmtpReply | null> => {
      if (input.mode !== "starttls") {
        return plainEhlo;
      }

      if (
        !plainEhlo.extensions.some(
          (e) => e === "STARTTLS" || e.startsWith("STARTTLS ")
        )
      ) {
        failAll(
          "failed",
          "UPSTREAM_ERROR",
          "smtp server does not offer STARTTLS"
        );

        return null;
      }

      await command("STARTTLS", (code) => code === 220);
      const plainSocket = socket;
      const plainReader = reader;
      const plainWriter = writer;

      if (!plainSocket) {
        throw new SmtpError("smtp connection closed");
      }

      if (plainReader) {
        plainReader.release();
      }

      if (plainWriter) {
        await plainWriter.close().catch(() => null);
      }

      socket = plainSocket.startTls({ expectedServerHostname: input.host });
      writer = socket.writable.getWriter();
      reader = new SmtpLineReader(socket);

      return command(`EHLO ${input.ehloName}`, (code) => code === 250);
    };

    const ehlo = await maybeUpgradeToTls(greetingEhlo);

    if (!ehlo) {
      return outcomes;
    }

    if (input.username !== null) {
      const authed = await smtpAuth(
        command,
        ehlo.extensions,
        input.username,
        input.password
      ).catch(() => false);

      if (!authed) {
        failAll("failed", "UPSTREAM_ERROR", "smtp authentication failed");

        return outcomes;
      }
    }

    try {
      await command(`MAIL FROM:<${input.from}>`, (code) => code === 250);
    } catch (error) {
      failAll(
        "failed",
        "UPSTREAM_ERROR",
        smtpFailureText(error, "smtp MAIL FROM rejected")
      );

      return outcomes;
    }

    const accepted: string[] = [];

    for (const recipient of input.recipients) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- SMTP is lock-step: one RCPT per round trip
        await command(
          `RCPT TO:<${recipient}>`,
          (code) => code === 250 || code === 251
        );
        accepted.push(recipient);
      } catch (error) {
        const reply = error instanceof SmtpError ? error.reply : null;
        // 5xx is permanent (bad destination); 4xx is transient (server policy).
        const permanent = reply === null || reply.code >= 500;
        outcomes.set(recipient, {
          code: permanent ? "UNVERIFIED_DESTINATION" : "UPSTREAM_ERROR",
          message: smtpFailureText(error, `recipient '${recipient}' rejected`),
          ok: false,
          state: "failed",
        });
      }
    }

    if (accepted.length === 0) {
      return outcomes;
    }

    const runDataPhase = async (): Promise<void> => {
      try {
        await command("DATA", (code) => code === 354);
      } catch (error) {
        for (const r of accepted) {
          outcomes.set(r, {
            code: "UPSTREAM_ERROR",
            message: smtpFailureText(error, "smtp DATA rejected"),
            ok: false,
            state: "failed",
          });
        }

        return;
      }

      try {
        // Once the DATA bytes leave, a timeout or disconnect means the server
        // may have queued the message — see the `outcome_unknown` catch below.
        const endReply = await withTimeout(
          input.commandTimeoutMs,
          async () => {
            const activeWriter = writer;
            const activeReader = reader;

            if (activeWriter === null || activeReader === null) {
              throw new SmtpError("smtp connection closed");
            }

            await activeWriter.write(dotStuffForSmtp(input.raw));
            await activeWriter.write(encoder.encode(".\r\n"));

            return activeReader.readReply();
          },
          () => new SmtpTimeoutError()
        );

        if (endReply.code !== 250) {
          for (const r of accepted) {
            outcomes.set(r, {
              code: "UPSTREAM_ERROR",
              message: `smtp DATA refused: ${sanitizeForLog(endReply.text, SMTP_REPLY_TEXT_MAX_CHARS)}`,
              ok: false,
              state: "failed",
            });
          }

          return;
        }

        const messageId = sanitizeForLog(
          endReply.text,
          SMTP_MESSAGE_ID_MAX_CHARS
        );

        for (const r of accepted) {
          outcomes.set(r, { messageId, ok: true });
        }
      } catch {
        // Timeout or disconnect after the bytes left: the server may have
        // queued the message. Never report a silent success or a definite
        // failure.
        for (const r of accepted) {
          outcomes.set(r, {
            code: "OUTCOME_UNKNOWN",
            message:
              "provider outcome unknown; inspect email logs before retrying",
            ok: false,
            state: "outcome_unknown",
          });
        }
      }
    };

    await runDataPhase();

    return outcomes;
  } catch (error) {
    // Pre-DATA failures (connect, greeting, EHLO, TLS, MAIL): nothing was
    // accepted, so `failed` is accurate.
    failAll(
      "failed",
      "UPSTREAM_ERROR",
      smtpFailureText(error, "smtp submission failed")
    );

    return outcomes;
  } finally {
    if (writer) {
      try {
        writer.releaseLock();
      } catch {
        // Already closed by the STARTTLS upgrade path.
      }
    }

    if (reader) {
      try {
        reader.release();
      } catch {
        // Already released by the STARTTLS upgrade path.
      }
    }

    if (socket) {
      try {
        const quitWriter = socket.writable.getWriter();
        await quitWriter.write(encoder.encode("QUIT\r\n")).catch(() => null);
        quitWriter.releaseLock();
      } catch {
        // Best effort on a broken connection.
      }

      await socket.close().catch(() => null);
    }
  }
};
