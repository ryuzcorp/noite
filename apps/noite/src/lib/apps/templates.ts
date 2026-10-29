//! The templates the create page offers (A3): public git repos created through
//! the same import path as a GitHub import, with their history squashed into
//! one commit. They live in one repo (`ryuzcorp/noite-templates`) as
//! `templates/<id>/`, published by the operator, never by an agent; the
//! runner allowlists `github.com`, so `url` must be a GitHub https URL and
//! `ref` a branch, tag or sha.
export interface AppTemplate {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  /** Folder inside the templates repo that becomes the app's root. */
  readonly path: string;
  readonly ref: string;
  /** Short tags for the picker card (framework, renderer, build tool). */
  readonly stack: readonly string[];
  readonly url: string;
}

export const TEMPLATES: readonly AppTemplate[] = [
  {
    description: "Ilha pages on Void (Vite), served by celld.",
    id: "ilha-void",
    name: "Ilha + Void",
    path: "templates/ilha-void",
    ref: "main",
    stack: ["Ilha", "Void", "Vite"],
    url: "https://github.com/ryuzcorp/noite-templates",
  },
  {
    description: "TanStack Start (Vite + the Cloudflare plugin) serving SSR.",
    id: "tanstack-start",
    name: "TanStack Start",
    path: "templates/tanstack-start",
    ref: "main",
    stack: ["TanStack Start", "SSR", "Vite"],
    url: "https://github.com/ryuzcorp/noite-templates",
  },
  {
    description:
      "Pi agent harness on Durable Objects (Pi Durable), tools in a Sandbox container.",
    id: "agent",
    name: "Agent",
    path: "templates/agent",
    ref: "main",
    stack: ["Pi Durable", "Sandbox", "celld"],
    url: "https://github.com/ryuzcorp/noite-templates",
  },
];
