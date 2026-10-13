/**
 * Copy-paste setup for the agents the account page offers (alpha.4 A4): each
 * entry is the real config the client reads, generated from the control UI's
 * own origin and the account's API key. Kept apart from the card so the
 * snippets are plain values (testable, and nothing here needs the DOM).
 */

/** What the key placeholder reads as when no key was just created — the
 * account page only ever shows a raw key once. */
export const KEY_PLACEHOLDER = "noite_…";

export interface AgentSnippet {
  /** Where the snippet goes, e.g. a file path or "terminal". */
  hint: string;
  id: string;
  label: string;
  /** The exact text to paste, with the real key when one is at hand. */
  text: string;
}

/** The snippets, in the order the card shows them. */
export const agentSnippets = ({
  apiKey,
  origin,
}: {
  apiKey: string | null;
  origin: string;
}): AgentSnippet[] => {
  const key = apiKey ?? KEY_PLACEHOLDER;
  const url = `${origin}/mcp`;
  return [
    {
      hint: "One command in your terminal:",
      id: "claude-code",
      label: "Claude Code",
      text: `claude mcp add --transport http noite ${url} --header "Authorization: Bearer ${key}"`,
    },
    {
      hint: "Project file .cursor/mcp.json (or ~/.cursor/mcp.json for every project):",
      id: "cursor",
      label: "Cursor",
      text: JSON.stringify(
        {
          mcpServers: {
            noite: { headers: { Authorization: `Bearer ${key}` }, url },
          },
        },
        null,
        2
      ),
    },
    {
      hint: "In ~/.codex/config.toml (or .codex/config.toml in a trusted project):",
      id: "codex",
      label: "Codex",
      text: [
        "[mcp_servers.noite]",
        `url = "${url}"`,
        `http_headers = { Authorization = "Bearer ${key}" }`,
        "",
      ].join("\n"),
    },
  ];
};
