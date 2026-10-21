//! Envelope parser tests on REAL `@sentry/browser` 11.8.0 wire bytes.
//!
//! Provenance: `sentry-fixtures/*.envelope.txt` are raw POST bodies captured
//! from the stock SDK against a local HTTP sink (`POST /api/42/envelope/`),
//! unmodified except `multi.envelope.txt`, which concatenates the exception
//! envelope's header + event item with the session envelope's session item
//! (all bytes SDK-originated) to exercise multi-item scanning. The SDK ran
//! with `release: "capture-test@1.2.3"`, `environment: "capture"` and
//! `tracesSampleRate: 1.0`; the stubbed page had no URL, so `request.url`
//! is empty here and the query-strip mapping is asserted on a synthetic
//! event object (mapping input, not envelope shape).
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import {
  mapSentryEvent,
  parseSentryAuth,
  parseSentryEnvelope,
} from "./sentry-envelope";

const fixture = (name: string): string =>
  fs.readFileSync(path.join(import.meta.dir, "sentry-fixtures", name), "utf-8");

describe("parseSentryEnvelope on real SDK bytes", () => {
  test("an exception envelope yields one browser event, oldest-first", () => {
    const parsed = parseSentryEnvelope(fixture("exception.envelope.txt"));

    expect(parsed.dropped).toEqual([]);
    expect(parsed.events.length).toBe(1);

    const [event] = parsed.events;
    expect(event?.kind).toBe("TypeError");
    expect(event?.message).toBe("declined: insufficient funds");
    expect(event?.source).toBe("browser");
    expect(event?.release).toBe("capture-test@1.2.3");
    expect(event?.environment).toBe("capture");
    expect(event?.traceId).toBe("7555f681bb764f67b146aead14b8fe88");
    expect(event?.timestampUs).toBe(1_792_532_567_830_000);
    expect(event?.userAgent).toContain("Chrome/131.0.0.0");

    // Sentry lists frames oldest-first: the node internals first, the throw
    // site last. The runner reverses them into phase-1 order.
    const frames = event?.frames ?? [];
    expect(frames.length).toBe(4);
    expect(frames[0]?.function).toBe("process.processTicksAndRejections");
    expect(frames[3]?.function).toBe("chargeCard");
    expect(frames[3]?.location).toBe(
      "file:///tmp/sentry-capture/capture.mjs:78:11"
    );
  });

  test("a message envelope without a type becomes a Message event", () => {
    const parsed = parseSentryEnvelope(fixture("message.envelope.txt"));

    expect(parsed.events.length).toBe(1);
    expect(parsed.events[0]?.kind).toBe("Message");
    expect(parsed.events[0]?.message).toBe("checkout banner dismissed");
    expect(parsed.events[0]?.source).toBe("browser");
  });

  test("session and span envelopes are accepted and dropped with a 200 shape", () => {
    const session = parseSentryEnvelope(fixture("session.envelope.txt"));
    const spans = parseSentryEnvelope(fixture("spans.envelope.txt"));

    expect(session.events).toEqual([]);
    expect(session.dropped).toEqual(["session"]);
    expect(spans.events).toEqual([]);
    expect(spans.dropped).toEqual(["span"]);
  });

  test("a multi-item envelope keeps the event and drops the session", () => {
    const parsed = parseSentryEnvelope(fixture("multi.envelope.txt"));

    expect(parsed.events.length).toBe(1);
    expect(parsed.events[0]?.kind).toBe("TypeError");
    expect(parsed.dropped).toEqual(["session"]);
  });

  test("garbage lines never break the scan; a broken header rejects", () => {
    const [header, itemHeader, payload] = fixture(
      "exception.envelope.txt"
    ).split("\n");

    expect(
      parseSentryEnvelope(`${header}\ngarbage\n${itemHeader}\n${payload}\n`)
        .events.length
    ).toBe(1);
    expect(
      parseSentryEnvelope(`${header}\n${itemHeader}\nnot json\n`).events
    ).toEqual([]);
    expect(() => parseSentryEnvelope("not json at all")).toThrow(
      "invalid sentry envelope"
    );
    expect(() => parseSentryEnvelope("")).toThrow("invalid sentry envelope");
  });
});

describe("mapSentryEvent boundaries", () => {
  test("the page URL loses its query and fragment", () => {
    const mapped = mapSentryEvent(
      {
        exception: { values: [{ type: "TypeError", value: "x" }] },
        platform: "javascript",
        request: {
          url: "https://shop.example.com/pricing?plan=pro&utm=capture#pay",
        },
        sdk: { name: "sentry.javascript.browser" },
      },
      {}
    );

    expect(mapped.url).toBe("https://shop.example.com/pricing");
    expect(mapped.frames).toEqual([]);
  });

  test("a node-platform event is an sdk event, and release falls back to the header trace", () => {
    const mapped = mapSentryEvent(
      {
        exception: { values: [{ type: "Error", value: "boom" }] },
        platform: "node",
      },
      { trace: { environment: "production", release: "api@9.9.9" } }
    );

    expect(mapped.source).toBe("sdk");
    expect(mapped.release).toBe("api@9.9.9");
    expect(mapped.environment).toBe("production");
    expect(mapped.timestampUs).toBe(0);
  });
});

describe("parseSentryAuth", () => {
  test("reads sentry_key out of the header form", () => {
    expect(
      parseSentryAuth(
        "Sentry sentry_version=7, sentry_client=sentry.javascript.browser/11.8.0, sentry_key=abc123"
      )
    ).toBe("abc123");
    expect(parseSentryAuth(null)).toBe(null);
    expect(parseSentryAuth("Bearer abc123")).toBe(null);
    expect(parseSentryAuth("Sentry sentry_version=7")).toBe(null);
  });
});
