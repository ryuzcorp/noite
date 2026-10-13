import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createPoder } from "../src/index.ts";
import { bunDriver, makeProjectDir } from "./driver.ts";
import * as counterModule from "./fixtures/counter.ts";

interface CounterBody {
  n: number;
}

interface IndexEntry {
  binding: string;
  kind: string;
  name: string;
}

// Sized so STATE_ROOT is 26 chars under /tmp, mirroring the pod's stateDir:
// every database path must then land exactly on the 56-char pod cap.
const STATE_ROOT = path.join(tmpdir(), "poder-layout-probe-00");

const bindings = {
  d1: [
    { binding: "DB", databaseName: "demo" },
    {
      binding: "DB2",
      databaseName: "a-very-long-database-name-exceeding-any-sane-limit",
    },
  ],
  durableObjects: [{ binding: "COUNTER", className: "Counter" }],
  kv: [{ binding: "CACHE", id: "a-very-long-kv-namespace-id-0123456789" }],
};

const listDbFiles = (): string[] =>
  readdirSync(path.join(STATE_ROOT, "db"))
    .filter((file) => file.endsWith(".sqlite"))
    .toSorted();

describe("flat database layout", () => {
  it("keeps every sqlite path short, indexed, and stable", async () => {
    rmSync(STATE_ROOT, { force: true, recursive: true });
    mkdirSync(STATE_ROOT, { recursive: true });
    const options = {
      bindings,
      projectDir: makeProjectDir(),
      sqlite: bunDriver,
      stateDir: STATE_ROOT,
      workerModule: { ...counterModule },
    };
    const first = await createPoder(options);
    const one = await first.fetch(new Request("https://pod/?name=a"));
    // SAFETY: the Counter fixture answers {n} JSON for counting requests.
    const oneBody = (await one.json()) as CounterBody;
    expect(oneBody.n).toBe(1);

    const files = listDbFiles();
    expect(files).toHaveLength(4);
    for (const file of files) {
      expect(file).toMatch(/^(?:d1|kv|do)-[0-9a-f]{16}\.sqlite$/u);
      expect(path.join(STATE_ROOT, "db", file).length).toBe(
        STATE_ROOT.length + 30
      );
    }
    expect(STATE_ROOT.length + 30).toBeLessThanOrEqual(56);

    // SAFETY: index.json is poder-written from the DbIndexEntry contract above.
    const index = JSON.parse(
      readFileSync(path.join(STATE_ROOT, "db", "index.json"), "utf-8")
    ) as Record<string, IndexEntry>;
    expect(Object.keys(index).toSorted()).toEqual(files);
    const kinds = Object.values(index)
      .map((entry) => entry.kind)
      .toSorted();
    expect(kinds).toEqual(["d1", "d1", "do", "kv"]);
    await first.dispose();

    const second = await createPoder(options);
    try {
      expect(listDbFiles()).toEqual(files);
      const two = await second.fetch(new Request("https://pod/?name=a"));
      // SAFETY: same Counter fixture shape as above.
      const twoBody = (await two.json()) as CounterBody;
      expect(twoBody.n).toBe(2);
    } finally {
      await second.dispose();
    }
  });
});
