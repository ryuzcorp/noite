import { describe, expect, test } from "bun:test";

import { agentSnippets, KEY_PLACEHOLDER } from "./snippets";

describe("agent setup snippets", () => {
  const origin = "https://noite.example";

  test("each client's config carries the endpoint and the key", () => {
    const snippets = agentSnippets({ apiKey: "noite_testkey", origin });
    expect(snippets.map((snippet) => snippet.id)).toEqual([
      "claude-code",
      "cursor",
      "codex",
    ]);
    for (const snippet of snippets) {
      expect(snippet.text).toContain(`${origin}/mcp`);
      expect(snippet.text).toContain("noite_testkey");
      expect(snippet.hint.length).toBeGreaterThan(0);
    }
  });

  test("the snippets are the formats each client reads", () => {
    const cursor = agentSnippets({ apiKey: "noite_testkey", origin }).find(
      (snippet) => snippet.id === "cursor"
    )?.text;
    expect(JSON.parse(cursor ?? "null")).toEqual({
      mcpServers: {
        noite: {
          headers: { Authorization: "Bearer noite_testkey" },
          url: `${origin}/mcp`,
        },
      },
    });

    const byId = new Map(
      agentSnippets({ apiKey: "noite_testkey", origin }).map((snippet) => [
        snippet.id,
        snippet.text,
      ])
    );
    expect(byId.get("claude-code")).toContain(
      `claude mcp add --transport http noite ${origin}/mcp`
    );
    expect(byId.get("codex")).toContain(
      `[mcp_servers.noite]\nurl = "${origin}/mcp"`
    );
    expect(byId.get("codex")).toContain(
      'http_headers = { Authorization = "Bearer noite_testkey" }'
    );
  });

  test("without a freshly created key the snippets show the placeholder", () => {
    for (const snippet of agentSnippets({ apiKey: null, origin })) {
      expect(snippet.text).toContain(KEY_PLACEHOLDER);
      expect(snippet.text).not.toContain("noite_testkey");
    }
  });
});
