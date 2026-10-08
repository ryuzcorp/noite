//! The templates the create page offers (A3): public git repos created through
//! the same import path as a GitHub import, with their history squashed into
//! one commit. They are published by the operator (`ryuzcorp/noite-template-*`),
//! never by an agent; the runner allowlists `github.com`, so `url` must be a
//! GitHub https URL and `ref` a branch, tag or sha.

export interface AppTemplate {
  readonly description: string;
  readonly id: string;
  readonly name: string;
  readonly ref: string;
  readonly url: string;
}

export const TEMPLATES: readonly AppTemplate[] = [
  {
    description:
      "Oxide worker with the ilha router and Vite — the shape this control UI runs on.",
    id: "oxide",
    name: "Oxide + ilha",
    ref: "main",
    url: "https://github.com/ryuzcorp/noite-template-oxide",
  },
  {
    description: "TanStack Start (Vite + the Cloudflare plugin) serving SSR.",
    id: "tanstack-start",
    name: "TanStack Start",
    ref: "main",
    url: "https://github.com/ryuzcorp/noite-template-tanstack-start",
  },
];
