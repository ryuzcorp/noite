import { describe, expect, test } from "bun:test";

import {
  cfgTestFiles,
  cfgTestSpans,
  checkConfig,
  checkE2e,
  checkFlags,
  checkRust,
  checkUiTest,
  stripRust,
  stripTs,
  testFns,
} from "./check-tests";

describe("stripTs", () => {
  test("a wait named in a comment or a string is not code", () => {
    const source = [
      "// page.waitForTimeout(1000) was here",
      'const label = "setTimeout(500)";',
      "await settleCycle();",
      "",
    ].join("\n");

    const stripped = stripTs(source);
    expect(stripped).not.toContain("waitForTimeout");
    expect(stripped).not.toContain("setTimeout");
    expect(stripped).toContain("settleCycle");
    expect(checkE2e("e2e/a.spec.ts", source)).toEqual([]);
  });

  test("a wait inside a template expression is still code", () => {
    // The sigil spans two literals so the fixture holds a literal template
    // expression without interpolating it here.
    const source = ["const next = `$", "{setTimeout(handler, 20)}`;", ""].join(
      ""
    );

    const violations = checkE2e("e2e/a.spec.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
  });

  test("line numbers survive stripping", () => {
    const source = [
      'import { expect } from "@playwright/test";',
      "// nothing here",
      "await page.waitForTimeout(1000);",
      "",
    ].join("\n");

    const violations = checkE2e("e2e/a.spec.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });

  test("a regex holding // and quotes is consumed, not derailed", () => {
    const source = [
      'const keep = git.replace(/^https?://u, "");',
      "await sleep(1000);",
      "",
    ].join("\n");

    const stripped = stripTs(source);
    expect(stripped).toContain("await sleep(1000);");
    expect(stripped).not.toContain("https?");
    const violations = checkE2e("e2e/a.spec.ts", source);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  test("division stays code", () => {
    const source = [
      "const ratio = total / count;",
      "await sleep(1000);",
      "",
    ].join("\n");

    expect(stripTs(source)).toContain("total / count");
    expect(checkE2e("e2e/a.spec.ts", source)).toHaveLength(1);
  });
});

describe("playwright config and specs", () => {
  test("project retries other than 0 fail, retries: 0 passes", () => {
    const bad = checkConfig(
      "apps/noite/playwright.config.ts",
      'export default defineConfig({ projects: [{ name: "setup", retries: 1 }] });\n'
    );

    expect(bad).toHaveLength(1);
    expect(bad[0]?.rule).toBe("no-test-retry");
    expect(bad[0]?.line).toBe(1);
    expect(bad[0]?.hint).toContain("fix the flake at its root");

    const ok = checkConfig(
      "apps/noite/playwright.config.ts",
      "export default defineConfig({ retries: 0 });\n"
    );

    expect(ok).toEqual([]);
  });

  test("describe.configure retries and test.info().retry branching fail", () => {
    const source = [
      'test.describe.configure({ mode: "serial", retries: 2 });',
      "if (test.info().retry > 0) { return; }",
      "",
    ].join("\n");

    const violations = checkE2e("e2e/a.spec.ts", source);
    expect(violations.map((v) => v.rule)).toEqual([
      "no-test-retry",
      "no-test-retry",
    ]);
  });

  test.each([
    ["await page.waitForTimeout(1000);", 1],
    ["const timer = setTimeout(() => abort(), 4000);", 1],
    ["await Bun.sleep(200);", 1],
    ["await sleep(DEPLOY_POLL_MS);", 1],
  ])("%s fails", (line, count) => {
    expect(checkE2e("e2e/a.spec.ts", `${line}\n`)).toHaveLength(count);
  });

  test("abortable helpers and deadlines are not waits", () => {
    const source = [
      "await sleepUnlessAborted(20, signal);",
      "const signal = AbortSignal.timeout(2000);",
      "await expect.poll(() => ready(), { timeout: 1000 }).toBe(true);",
      "",
    ].join("\n");

    expect(checkE2e("e2e/a.spec.ts", source)).toEqual([]);
  });
});

describe("UI unit tests", () => {
  test("wall-clock waits fail without fake timers", () => {
    const source = [
      "await Bun.sleep(200);",
      "await sleep(30);",
      "const timer = setTimeout(() => fire(), 20);",
      "",
    ].join("\n");

    const violations = checkUiTest("src/lib/x.test.ts", source);
    expect(violations).toHaveLength(3);
    expect(violations.every((v) => v.rule === "no-wall-clock-sleep")).toBe(
      true
    );
  });

  test("fake timers exempt the file", () => {
    const source = [
      "jest.useFakeTimers();",
      "const timer = setTimeout(() => fire(), 20);",
      "",
    ].join("\n");

    expect(checkUiTest("src/lib/x.test.ts", source)).toEqual([]);
  });

  test("a hand-rolled clock (assigned setTimeout) exempts the file", () => {
    const source = [
      "globalThis.setTimeout = ((handler: () => void) => 1) as typeof setTimeout;",
      "const timer = setTimeout(() => fire(), 20);",
      "",
    ].join("\n");

    expect(checkUiTest("src/lib/x.test.ts", source)).toEqual([]);
  });
});

describe("shell and workflow flags", () => {
  test("--retries fails, curl --retry does not", () => {
    const violations = checkFlags(
      "docker/e2e-local.sh",
      "npx playwright test --retries 2\n"
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("no-retry-flag");

    const ok = checkFlags(
      "docker/install-sidecars.sh",
      "curl -fsSL --retry 5 --retry-all-errors https://example.com | tar -xz\n"
    );

    expect(ok).toEqual([]);
  });
});

describe("rust brace spans", () => {
  test("only sleeps inside a cfg(test) module count", () => {
    const source = [
      "pub async fn deploy() {",
      "    tokio::time::sleep(Duration::from_secs(5)).await;",
      "}",
      "",
      "#[cfg(test)]",
      "mod tests {",
      "    #[tokio::test]",
      "    async fn waits() {",
      "        tokio::time::sleep(Duration::from_millis(400)).await;",
      "    }",
      "}",
      "",
    ].join("\n");

    const stripped = stripRust(source);
    expect(cfgTestSpans(stripped)).toHaveLength(1);
    const violations = checkRust("src/service/apps.rs", source, false);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(9);
  });

  test("braces in strings and comments do not move the span", () => {
    const source = [
      "#[cfg(test)]",
      "mod tests {",
      "    #[tokio::test]",
      "    async fn waits() {",
      '        // a } brace and "{" string',
      '        let label = "}{";',
      "        tokio::time::sleep(Duration::from_millis(400)).await;",
      "    }",
      "}",
      "fn other() {",
      "    tokio::time::sleep(Duration::from_millis(1)).await;",
      "}",
      "",
    ].join("\n");

    const violations = checkRust("src/x.rs", source, false);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(7);
  });

  test("tests.rs files count wholesale", () => {
    const source = [
      "#[tokio::test]",
      "async fn waits() {",
      "    std::thread::sleep(Duration::from_millis(10));",
      "}",
      "",
    ].join("\n");

    const violations = checkRust("src/api/tests.rs", source, true);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(3);
  });
});

/** A one-test `mod tests` fixture with the given attribute and body. */
const attempt = (attr: string, body: string): string =>
  [
    "#[cfg(test)]",
    "mod tests {",
    `    ${attr}`,
    "    async fn waits() {",
    ...body.split("\n").map((line) => `        ${line}`),
    "    }",
    "}",
    "",
  ].join("\n");

describe("rust paused time", () => {
  test("start_paused exempts the sleep", () => {
    const source = attempt(
      "#[tokio::test(start_paused = true)]",
      "tokio::time::sleep(Duration::from_millis(600)).await;"
    );

    expect(checkRust("src/x.rs", source, false)).toEqual([]);
  });

  test("pause() in the same test exempts the sleep", () => {
    const source = attempt(
      "#[tokio::test]",
      [
        "tokio::time::pause();",
        "let wedged = with_timeout(core::future::pending::<()>());",
        "tokio::time::advance(Duration::from_secs(1)).await;",
        "tokio::time::sleep(Duration::from_millis(1)).await;",
      ].join("\n")
    );

    expect(checkRust("src/x.rs", source, false)).toEqual([]);
  });

  test("pause() in a sibling test does not exempt", () => {
    const source = [
      "#[cfg(test)]",
      "mod tests {",
      "    #[tokio::test]",
      "    async fn paused_neighbor() {",
      "        tokio::time::pause();",
      "    }",
      "    #[tokio::test]",
      "    async fn waits() {",
      "        tokio::time::sleep(Duration::from_millis(400)).await;",
      "    }",
      "}",
      "",
    ].join("\n");

    const violations = checkRust("src/x.rs", source, false);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(9);
  });

  test("a sleep in a non-test helper fails", () => {
    const source = [
      "#[cfg(test)]",
      "mod testutil {",
      "    pub async fn wait(marker: &str) -> bool {",
      "        tokio::time::sleep(Duration::from_millis(50)).await;",
      "        true",
      "    }",
      "}",
      "",
    ].join("\n");

    const violations = checkRust("src/testutil.rs", source, false);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(4);
  });
});

describe("rust declaration-gated modules", () => {
  test("cfg(test) mod declarations mark whole files", () => {
    const root = ["mod deploy;", "#[cfg(test)]", "mod testutil;", ""].join(
      "\n"
    );

    expect(cfgTestFiles(stripRust(root))).toEqual(new Set(["testutil.rs"]));

    const helper = [
      "pub async fn wait(marker: &str) -> bool {",
      "    tokio::time::sleep(Duration::from_millis(50)).await;",
      "    true",
      "}",
      "",
    ].join("\n");

    expect(checkRust("src/testutil.rs", helper, true)).toHaveLength(1);
    expect(checkRust("src/deploy.rs", helper, false)).toEqual([]);
  });
});

describe("testFns and spans", () => {
  test("finds attributes and bodies", () => {
    const stripped = stripTs("x");
    expect(stripped).toBe("x");

    const source = [
      "#[cfg(test)]",
      "mod tests {",
      "    #[tokio::test(start_paused = true)]",
      "    async fn waits() {",
      "        tokio::time::sleep(Duration::from_millis(1)).await;",
      "    }",
      "}",
      "",
    ].join("\n");

    const fns = testFns(stripRust(source));
    expect(fns).toHaveLength(1);
    expect(fns[0]?.attr).toContain("start_paused");
    expect(fns[0]?.body).toContain("tokio::time::sleep");
    expect(cfgTestSpans(stripRust(source))).toHaveLength(1);
  });
});
