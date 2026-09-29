# Noite landing page: proposed content

Draft copy for `noite.now/`, replacing `docs/index.mdx` as the front door. Every claim below is backed by the docs or SPEC; the notes in _italics_ are for us, not the page.

---

## 1. Hero

**Headline** (pick one):

- **The app platform you own.**
- **git push. It's live. On a box you own.**
- **The PaaS that fits on a $5 VPS.**

_Recommendation: lead with the first. It leads with what people want (ownership) in five words, without naming another vendor. Use the second as the section title for "How it works"._

**Subhead:**

> Noite is a tiny, self-hostable platform for your apps, with durable objects, SQL databases and object storage included. One command installs it, one image runs it, and your data lives in a bucket you own.

**Primary CTA:** the install command, as a copyable block with the copy button, not a button:

```bash
curl -fsSL https://noite.now/install.sh | sudo bash
```

**Secondary CTAs:** `Read the quickstart →` · `View on GitHub`

**Micro-line under the command:**

> Ubuntu or Debian · amd64 or arm64 · 2 GB of RAM · no domain needed to try it

_Visual: a terminal on the right that plays the install (Docker ✓, secrets ✓, waiting for /ready ✓, "Noite is running."), then cuts to `git push` → `https://hello.<domain>`. Dark by default, since the name means "night"._

---

## 2. Three steps (the "git push" section)

**Title:** git push. It's live.

| 1. Install | 2. Push | 3. Open |
| --- | --- | --- |
| Run one command on any fresh VPS. Noite installs Docker, generates its secrets, and gets its own TLS certificates. | Create an app, add the remote, and push to `main`. Noite installs, builds, runs your release command, and deploys. | Every app gets `https://<slug>.<your-domain>` automatically. Add your own domains in one click. |

Code strip under the steps:

```bash
git remote add origin https://git:$KEY@git.example.com/hello
git push -u origin main
# → https://hello.example.com
```

---

## 3. Feature grid

**Title:** Everything a small platform needs. Nothing it doesn't.

_Six to nine cards, each an icon, a bold line and one sentence._

- **Bring your Workers app.** Many Cloudflare Workers apps move over as they are: deploy with the `wrangler.jsonc` you already have, or a `cloudflare.config.ts`. Durable Objects, D1, R2 and static assets run on [celld](https://celld.dev), and its docs list every supported API.
- **Scale to zero, for real.** Apps idle for a day go to sleep and free their memory. The next request wakes them and is served normally: no splash page, no dropped request.
- **Observability built in.** Live logs, 24 h metrics (requests, errors, latency, CPU) and slow-request spans for every app. No collector to run.
- **Look inside your data.** Browse each app's D1 tables, R2 objects and Durable Objects from the dashboard.
- **Instant rollback.** Every successful deploy is kept as an immutable bundle. Roll back to any of them in one click.
- **Deploy from CI.** `bunx @noitenow/cli deploy` ships a prebuilt `dist/` from GitHub Actions and comments the URL on your pull request.
- **Domains and TLS, handled.** Automatic subdomains, custom domains with on-demand certificates, and no wildcard certificate or DNS API needed.
- **Passkeys, not passwords.** Sign-in is passkey-first. Registration is invite-only, and every member has codes to invite others.
- **Share it safely.** Teammates get `view`, `push` or `admin` on each app. In multi-tenant mode, builds and apps run sandboxed, away from the platform's secrets and internal network.

---

## 4. "You own it" section

**Title:** Your server. Your bucket. Your bill.

> Noite keeps everything in one S3 bucket: your Git history, your apps' storage and its own state. Use the bundled store to get started, or point it at R2, S3 or Tigris. Lose the server and nothing is lost: a fresh install restores itself from the bucket.

Three stats in a row:

- **1** command to install
- **1** container to run
- **1** bucket to back up

_Optional secondary strip, clearly credited to celld: "Powered by celld: ~4 ms to wake a sleeping cell, ~0.5 MB of memory per resident cell." Source: celld.dev. Keep it credited, since these are celld's measured numbers, not ours._

---

## 5. Security section (short, confident)

**Title:** Built to let other people push code.

> In multi-tenant mode, builds and release commands run as unprivileged users with a cleared environment, and a firewall blocks tenants from localhost, private networks and cloud metadata. A dedicated hostile test app tries to read platform secrets and reach every internal API, and the isolation test suite checks that every attempt fails.

Link: `How tenant isolation works →` (`/self-hosting/tenancy`)

---

## 6. Runs anywhere

**Title:** Install it your way.

Tabs or logo row:

- **Any VPS:** `curl -fsSL https://noite.now/install.sh | sudo bash`
- **Docker Compose:** download `compose.yaml` and run `docker compose up -d`
- **Coolify:** point a Compose resource at the repo
- **Railway:** one service, one volume, one bucket

_Logos only where the docs have a guide (Coolify, Railway). No hosting-provider logos without a tested guide._

---

## 7. FAQ

**Can I migrate an app from Cloudflare Workers?** Often, yes, with some limits. Noite runs apps on celld, which supports fetch handlers, Durable Objects, D1, R2, KV, Queues, Workflows, Cron and static assets, and reads your existing `wrangler.jsonc`. Bindings outside that list won't work, and Wrangler config keys celld doesn't accept have to be removed. See celld's [supported APIs](https://celld.dev/docs/) for the details.

**How big a server do I need?** 2 GB of RAM is enough to start. Idle apps sleep and give their memory back, so many small apps fit on one box.

**Do I need a domain?** Not to try it. The installer falls back to `<your-ip>.sslip.io`, which works with no DNS setup. For real use, point `*.yourdomain` at the server.

**How do updates work?** Re-run the install command. It keeps your configuration and secrets, pulls the latest image and restarts.

**What does it cost?** Noite is open source (Apache-2.0). You pay for your server and your bucket, nothing else.

**Can my team use it?** Yes. Invite people with codes and give them `view`, `push` or `admin` on each app. Multi-tenant mode sandboxes everyone's code from the platform.

---

## 8. Final CTA

**Title:** Your next app is one push away.

```bash
curl -fsSL https://noite.now/install.sh | sudo bash
```

`Quickstart →` · `Docs →` · `GitHub →`

**Footer tagline:** _Noite: a tiny PaaS for the night shift._ (Or plainer: _Noite: tiny, self-hosted, yours._)

---

## Implementation notes (not page copy)

- **Route:** Blume mounts `.astro` files from `apps/website/pages/`, and a custom page overrides the generated route at the same path. `pages/index.astro` becomes `/`. Move `docs/index.mdx` to an intro page (e.g. `docs/introduction.mdx`) and point the header's "Docs" link at `/quickstart` or the intro.
- **SEO:** `<title>` "Noite: the app platform you own"; meta description = the subhead. Blume generates the Open Graph card for static custom pages.
- **Claims to keep honest:**
  - "Scale to zero": the first request after a quiet day waits for a cold start of a few seconds. Don't claim "instant wake"; say "served normally".
  - The celld numbers are celld's benchmarks; credit them or leave them out.
  - The logs view keeps recent output only (in-memory buffer), so don't promise log history or search.
  - The security copy describes `multi` mode only. Railway runs `single` because the platform doesn't grant the needed capabilities.
- **Not on the page yet:** Events/Insights (product analytics). The docs describe them, but it's unclear whether they're finished. Add a card once they are.
- **Brand:** the name is Portuguese for "night": a dark theme, a moon or star mark, and a calm tone. Avoid "blazing fast" and similar clichés; the one-command install is the hook.
