import { describe, expect, test } from "bun:test";

import * as Schema from "effect/Schema";

import { EventsSnapshotArgs } from "./events.server";

const decode = (input: { appId: string; limit?: number }) =>
  Schema.decodeUnknownSync(EventsSnapshotArgs)(input);

describe("EventsSnapshotArgs", () => {
  test("accepts an integer limit in range", () => {
    expect(decode({ appId: "a", limit: 50 })).toMatchObject({ limit: 50 });
  });

  test("rejects a fractional limit", () => {
    expect(() => decode({ appId: "a", limit: 1.5 })).toThrow();
  });

  test("rejects an out-of-range limit", () => {
    expect(() => decode({ appId: "a", limit: 0 })).toThrow();
    expect(() => decode({ appId: "a", limit: 1000 })).toThrow();
  });
});
