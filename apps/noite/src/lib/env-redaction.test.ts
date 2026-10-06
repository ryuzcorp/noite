import { expect, test } from "bun:test";

import { redactEnv } from "./server/env.server";

const row = (name: string, value: string) => ({
  name,
  updatedAt: "2026-01-01T00:00:00Z",
  value,
});

test("secret values never reach the browser", () => {
  expect(
    redactEnv(row("DATABASE_URL", "postgres://user:pw@host/db")).value
  ).toBe("");
  expect(redactEnv(row("STRIPE_KEY", "sk_live_123")).value).toBe("");
});

test("FLAG_ toggles keep their 1/0 so the switch can render", () => {
  expect(redactEnv(row("FLAG_DARK_LAUNCH", "1")).value).toBe("1");
  expect(redactEnv(row("FLAG_DARK_LAUNCH", "0")).value).toBe("0");
});

test("a FLAG_ variable holding anything but 1/0 is treated as a secret", () => {
  expect(redactEnv(row("FLAG_TOKEN", "hunter2")).value).toBe("");
});

test("only name and updatedAt travel besides the value", () => {
  expect(Object.keys(redactEnv(row("A", "b"))).toSorted()).toEqual([
    "name",
    "updatedAt",
    "value",
  ]);
});
