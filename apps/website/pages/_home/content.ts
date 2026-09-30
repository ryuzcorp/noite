// Landing page copy (apps/website/LANDING.md is the source draft). Every claim
// here is backed by the docs; keep it that way when editing.

export const INSTALL_COMMAND =
  "curl -fsSL https://noite.now/run.sh | sudo bash -s install";

export const GITHUB_URL = "https://github.com/ryuzcorp/noite";

export const DISCORD_URL = "https://discord.gg/WnVTMCTz74";

/**
 * Product tour. Until `src` is set the section renders a placeholder frame
 * with the planned chapters. To publish: drop the file in `public/` (e.g.
 * `public/tour.mp4`, plus a `public/tour.jpg` poster), set `src`/`poster`,
 * `duration`, and each chapter's real start time in seconds.
 */
export const TOUR = {
  chapters: [
    { at: 0, title: "Install on a fresh VPS with one command" },
    { at: 30, title: "Register the admin account with a passkey" },
    { at: 55, title: "Create an app and an API key" },
    { at: 75, title: "git push, watch the build log" },
    { at: 100, title: "Logs, metrics and the storage browser" },
    { at: 130, title: "Add a custom domain, roll back a deploy" },
  ],
  duration: "2:30",
  poster: "",
  src: "",
} as const;

/**
 * Hero terminal, one entry per line. `delay` and `tone` are literal Tailwind
 * classes (the scanner only sees whole strings), revealed in order by the
 * `animate-line-in` animation from theme.css.
 */
export const TERMINAL = [
  {
    delay: "",
    prefix: "$",
    text: "curl -fsSL https://noite.now/run.sh | sudo bash -s install",
    tone: "",
  },
  {
    delay: "[animation-delay:0.5s]",
    prefix: "==>",
    text: "Checking the system     Ubuntu 24.04 LTS",
    tone: "text-success",
  },
  {
    delay: "[animation-delay:0.9s]",
    prefix: "==>",
    text: "Installing Docker",
    tone: "text-success",
  },
  {
    delay: "[animation-delay:1.3s]",
    prefix: "==>",
    text: "Writing /opt/noite      fresh secrets",
    tone: "text-success",
  },
  {
    delay: "[animation-delay:1.8s]",
    prefix: "==>",
    text: "Starting Noite          ready",
    tone: "text-success",
  },
  {
    delay: "[animation-delay:2.3s]",
    prefix: "✓",
    text: "Noite is running. https://app.example.com",
    tone: "font-semibold text-base-content",
  },
  {
    delay: "[animation-delay:2.9s]",
    prefix: "$",
    text: "git push -u origin main",
    tone: "",
  },
  {
    delay: "[animation-delay:3.5s]",
    prefix: "",
    text: "remote: build ✓  release ✓  deploy ✓",
    tone: "text-base-content/70",
  },
  {
    delay: "[animation-delay:4s]",
    prefix: "→",
    text: "https://hello.example.com",
    tone: "font-semibold text-primary",
  },
] as const;

export const STEPS = [
  {
    body: "Run one command on any fresh VPS. Noite installs Docker, generates its secrets, and gets its own TLS certificates.",
    title: "Install",
  },
  {
    body: "Create an app, add the remote, and push to main. Noite installs, builds, runs your release command, and deploys.",
    title: "Push",
  },
  {
    body: "Every app gets https://<slug>.<your-domain> automatically. Add your own domains in one click.",
    title: "Open",
  },
] as const;

export const FEATURES = [
  {
    body: "Many Cloudflare Workers apps move over as they are: deploy with the wrangler.jsonc you already have, or a cloudflare.config.ts. Durable Objects, D1, R2 and static assets run on celld, and its docs list every supported API.",
    title: "Bring your Workers app",
  },
  {
    body: "Apps idle for a day go to sleep and free their memory. The next request wakes them and is served normally: no splash page, no dropped request.",
    title: "Scale to zero, for real",
  },
  {
    body: "Live logs, 24 h metrics (requests, errors, latency, CPU) and slow-request spans for every app. No collector to run.",
    title: "Observability built in",
  },
  {
    body: "Browse each app's D1 tables, R2 objects and Durable Objects from the dashboard.",
    title: "Look inside your data",
  },
  {
    body: "Every successful deploy is kept as an immutable bundle. Roll back to any of them in one click.",
    title: "Instant rollback",
  },
  {
    body: "bunx @noitenow/cli deploy ships a prebuilt dist/ from GitHub Actions and comments the URL on your pull request.",
    title: "Deploy from CI",
  },
  {
    body: "Automatic subdomains, custom domains with on-demand certificates, and no wildcard certificate or DNS API needed.",
    title: "Domains and TLS, handled",
  },
  {
    body: "Sign-in is passkey-first. Registration is invite-only, and every member has codes to invite others.",
    title: "Passkeys, not passwords",
  },
  {
    body: "Teammates get view, push or admin on each app. In multi-tenant mode, builds and apps run sandboxed, away from the platform's secrets.",
    title: "Share it safely",
  },
] as const;

export const INSTALL_TABS = [
  {
    code: INSTALL_COMMAND,
    id: "vps",
    label: "Any VPS",
    note: "Ubuntu or Debian, amd64 or arm64. Re-run it to upgrade.",
  },
  {
    code: "curl -fsSLO https://raw.githubusercontent.com/ryuzcorp/noite/main/docker/compose.yaml\ndocker compose up -d",
    id: "compose",
    label: "Docker Compose",
    note: "Boots a local trial on http://localhost:9080 with no .env at all.",
  },
  {
    code: "Docker Compose resource → repo ryuzcorp/noite\nCompose file: docker/compose.yaml · branch main",
    id: "coolify",
    label: "Coolify",
    note: "Set the domain and secrets as environment variables, then deploy.",
  },
  {
    code: "Service: ghcr.io/ryuzcorp/noite:latest\nVolume: /data · Domain: *.<your-domain> → port 80",
    id: "railway",
    label: "Railway",
    note: "One service, one volume, and R2, Tigris or a RustFS service as the bucket.",
  },
] as const;

export const FAQ = [
  {
    answer:
      "Often, yes, with some limits. Noite runs apps on celld, which supports fetch handlers, Durable Objects, D1, R2, KV, Queues, Workflows, Cron and static assets, and reads your existing wrangler.jsonc. Bindings outside that list won't work, and Wrangler config keys celld doesn't accept have to be removed. celld's docs list the supported APIs in detail.",
    question: "Can I migrate an app from Cloudflare Workers?",
  },
  {
    answer:
      "2 GB of RAM is enough to start. Idle apps sleep and give their memory back, so many small apps fit on one box.",
    question: "How big a server do I need?",
  },
  {
    answer:
      "Not to try it. The installer falls back to <your-ip>.sslip.io, which works with no DNS setup. For real use, point *.yourdomain at the server.",
    question: "Do I need a domain?",
  },
  {
    answer:
      "Re-run the install command. It keeps your configuration and secrets, pulls the latest image and restarts.",
    question: "How do updates work?",
  },
  {
    answer:
      "Noite is open source under Apache-2.0. You pay for your server and your bucket, nothing else.",
    question: "What does it cost?",
  },
  {
    answer:
      "Yes. Invite people with codes and give them view, push or admin on each app. Multi-tenant mode sandboxes everyone's code from the platform.",
    question: "Can my team use it?",
  },
] as const;

/** `m:ss` for a chapter start. */
export const formatTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, "0");
  return `${minutes}:${rest}`;
};
