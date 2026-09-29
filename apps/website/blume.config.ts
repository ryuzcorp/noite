import { defineConfig } from "blume";

export default defineConfig({
  deployment: {
    site: "https://noite.now",
  },
  description:
    "Your Cloudflare Workers, on your own server. A tiny self-hostable PaaS: one command installs it, git push deploys.",
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
  },
  title: "Noite",
});
