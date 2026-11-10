import { describe, expect, test } from "bun:test";

import { renderHtml } from "ilha/test";

import { LoginPanel } from "./login-panel";

const Probe = () => <LoginPanel />;

describe("login panel SSR", () => {
  test("renders the neutral panel and disabled controls", async () => {
    const html = await renderHtml(Probe);

    expect(html).toContain("Noite");
    expect(html).toContain("disabled");
  });
});
