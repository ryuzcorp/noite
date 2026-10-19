//! The sessionStorage quota contract: ordinary snapshots persist, bulky
//! ones (`persist: false`) stay in memory only, and a full or blocked store
//! degrades to memory instead of throwing.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { clearSwrStore, readSwr, writeSwr } from "./swr-store";

const backing = new Map<string, string>();
let failWrites = false;

const stub: Storage = {
  clear: () => {
    backing.clear();
  },
  getItem: (key: string) => backing.get(key) ?? null,
  key: (index: number) => [...backing.keys()][index] ?? null,
  get length() {
    return backing.size;
  },
  removeItem: (key: string) => {
    backing.delete(key);
  },
  setItem: (key: string, value: string) => {
    if (failWrites) {
      throw new Error("quota exceeded");
    }

    backing.set(key, value);
  },
};

beforeAll(() => {
  globalThis.sessionStorage = stub;
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "sessionStorage");
});

beforeEach(() => {
  backing.clear();
  failWrites = false;
  clearSwrStore();
});

describe("swr-store persistence", () => {
  test("ordinary entries persist to sessionStorage", () => {
    writeSwr("probe:ordinary", { n: 1 });
    expect(backing.get("swr:probe:ordinary")).toBe(`{"n":1}`);
    expect(readSwr<{ n: number }>("probe:ordinary")).toEqual({ n: 1 });
  });

  test("persist:false stays in memory only", () => {
    writeSwr("probe:bulky", { text: "x".repeat(1000) }, { persist: false });
    expect(backing.has("swr:probe:bulky")).toBe(false);
    expect(readSwr<{ text: string }>("probe:bulky")?.text).toHaveLength(1000);
  });

  test("a full store degrades to memory instead of throwing", () => {
    failWrites = true;
    expect(() => {
      writeSwr("probe:full", { n: 2 });
    }).not.toThrow();
    expect(backing.has("swr:probe:full")).toBe(false);
    expect(readSwr<{ n: number }>("probe:full")).toEqual({ n: 2 });
  });
});
