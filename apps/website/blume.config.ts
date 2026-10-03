import { defineConfig } from "blume";
import { posthog } from "blume/analytics";

const INTER = {
  name: "Inter",
  variants: [
    {
      src: "./node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
      style: "normal",
      weight: "100..900",
    },
  ],
} as const;
const PLEX_MONO = "./node_modules/@fontsource/ibm-plex-mono/files";

export default defineConfig({
  // PostHog, injected by Blume in production builds only (`blume dev` stays
  // clean). The project key is public and write-only.
  analytics: [
    posthog({
      defaults: "2026-05-30",
      host: "https://eu.i.posthog.com",
      key: "phc_tK7beVmX5qMx6tsBxVQdWATWMQcPpEV4iSYGu8nrNHyG",
    }),
  ],
  deployment: {
    site: "https://noite.now",
  },
  description:
    "The app platform you own. A tiny self-hostable PaaS: one command installs it, git push deploys.",
  // Header GitHub icon and "Edit on GitHub" page links.
  github: { dir: "apps/website", owner: "ryuzcorp", repo: "noite" },
  // currentColor mark (public/logo.svg, from apps/noite/public/logo.svg):
  // Blume inlines it, so it follows the theme and the transparent header.
  logo: { image: "/logo.svg", text: "Noite" },
  navigation: {
    // Discord renders as an icon button: see the header rule in theme.css.
    actions: [
      { href: "/introduction", label: "Docs" },
      { href: "https://discord.gg/WnVTMCTz74", label: "Discord" },
    ],
  },
  theme: {
    // Brand teal, from the control UI (apps/noite/src/app.css): its dark
    // primary as is; in light a deeper teal, since its light primary is too
    // faint for text on white. The dark page is a deep-ocean near-black.
    accent: {
      dark: "oklch(91% 0.096 180.426)",
      light: "oklch(51% 0.096 186.391)",
    },
    background: { dark: "oklch(15% 0.018 205)" },
    // Blume's defaults (Inter, IBM Plex Mono), but from Fontsource packages
    // instead of Google Fonts, so the build never fetches fonts over the
    // network (fonts.gstatic.com flakes in CI).
    fonts: {
      body: INTER,
      display: INTER,
      mono: {
        name: "IBM Plex Mono",
        variants: [400, 500, 600].map((weight) => ({
          src: `${PLEX_MONO}/ibm-plex-mono-latin-${weight}-normal.woff2`,
          weight,
        })),
      },
    },
  },
  title: "Noite",
});
