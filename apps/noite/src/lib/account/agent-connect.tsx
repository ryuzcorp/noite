//! "Connect an agent" (alpha.4 A4): the MCP endpoint and the setup each client
//! reads, next to the API keys that authenticate it. The key is only ever
//! shown once, so the card takes the freshly created key's atom: the snippets
//! use the real key while it is on screen and fall back to a placeholder
//! afterwards.

import type { AtomHandle } from "ilha";

import { agentSnippets } from "../mcp/snippets";
import { CopyButton } from "../ui/copy-button";

export const ConnectAgentCard = ({
  apiKey,
}: {
  apiKey: AtomHandle<string | null>;
}) => {
  const { origin } = window.location;
  const endpoint = `${origin}/mcp`;
  return (
    <section class="border-base-300 bg-base-100 dark:bg-base-200 rounded-box flex flex-col gap-4 border p-4 shadow-md">
      <div class="flex items-center justify-between gap-2">
        <h2 class="m-0 text-lg font-semibold">Connect an agent</h2>
        <CopyButton label="Copy MCP endpoint" value={endpoint} />
      </div>
      <p class="m-0 text-sm opacity-80">
        Point an MCP client at <code>{endpoint}</code> with{" "}
        <code>Authorization: Bearer &lt;key&gt;</code>. Create an API key above
        with the <strong>App Management</strong> scope: the agent's tools run as
        your account, with your collaborator roles.
      </p>
      {apiKey() ? (
        <p class="text-success m-0 text-sm">
          Filled in with the key you just created — copy it now, it is shown
          once.
        </p>
      ) : null}
      <div class="flex flex-col gap-3">
        {agentSnippets({ apiKey: apiKey(), origin }).map((snippet) => (
          <div
            key={snippet.id}
            class="border-base-300 flex flex-col gap-1 rounded border p-3"
          >
            <div class="flex items-center justify-between gap-2">
              <span class="text-sm font-medium">{snippet.label}</span>
              <CopyButton
                label={`Copy ${snippet.label} config`}
                value={snippet.text}
              />
            </div>
            <span class="text-xs opacity-70">{snippet.hint}</span>
            <pre class="m-0 overflow-x-auto text-xs">
              <code>{snippet.text}</code>
            </pre>
          </div>
        ))}
      </div>
    </section>
  );
};
