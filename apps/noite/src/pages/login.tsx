import { LoginPanel } from "$lib/auth/login-panel";
import { CloudUpload, Key, List } from "$lib/ui/icons";
import { head } from "@ilha/router";

const FEATURES = [
  {
    body: "Every app gets its own remote and subdomain.",
    icon: <CloudUpload size={18} />,
    title: "Deploys on git push",
  },
  {
    body: "Logs, metrics, errors and storage, no extra services.",
    icon: <List size={18} />,
    title: "Everything in one place",
  },
  {
    body: "One container on your server, your storage, your domain.",
    icon: <Key size={18} />,
    title: "Yours to run",
  },
];

const Logo = ({ class: cls }: { class: string }) => (
  <>
    <img src="/logo.svg" alt="Noite" class={`${cls} dark:hidden`} />
    <img src="/logo-dark.svg" alt="Noite" class={`${cls} hidden dark:block`} />
  </>
);

/** Static deploy transcript: shows the product in one glance. */
const DeployPreview = () => (
  <div class="border-base-300 bg-base-100 dark:bg-base-300 rounded-2xl border p-5 font-mono text-xs leading-relaxed shadow-sm">
    <p class="m-0">
      <span class="opacity-50">$ </span>git push noite main
    </p>
    <p class="text-success m-0 mt-2">✓ Built in 12s</p>
    <p class="m-0">
      <span class="text-success">✓ Live at </span>
      https://<span class="font-semibold">my-app</span>.example.com
    </p>
  </div>
);

export default function Login() {
  head({ title: "Sign in · Noite" });

  return (
    <div class="bg-base-100 grid min-h-screen lg:grid-cols-2">
      <aside class="bg-base-200 dark:bg-base-200 hidden flex-col justify-between gap-10 p-12 lg:flex">
        <a href="/" class="inline-flex w-fit" aria-label="Noite">
          <Logo class="h-8 w-auto" />
        </a>
        <div class="flex max-w-lg flex-col gap-10">
          <div class="flex flex-col gap-4">
            <h1 class="m-0 text-4xl leading-tight font-semibold tracking-tight">
              Push code. Get a URL.
            </h1>
            <p class="m-0 text-lg leading-relaxed opacity-70">
              Noite is a self-hosted home for your web apps. Push to a Git
              remote and it's live on your own domain.
            </p>
          </div>
          <ul class="m-0 flex list-none flex-col gap-5 p-0">
            {FEATURES.map((feature) => (
              <li key={feature.title} class="flex items-start gap-3">
                <span class="bg-base-100 dark:bg-base-300 border-base-300 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border">
                  {feature.icon}
                </span>
                <span class="flex flex-col">
                  <span class="text-sm font-medium">{feature.title}</span>
                  <span class="text-sm opacity-60">{feature.body}</span>
                </span>
              </li>
            ))}
          </ul>
          <DeployPreview />
        </div>
        <p class="m-0 text-xs opacity-50">Open source · Self-hosted</p>
      </aside>

      <main class="flex flex-col items-center justify-center px-6 py-12">
        <div class="flex w-full max-w-sm flex-col gap-8">
          <a href="/" class="inline-flex w-fit lg:hidden" aria-label="Noite">
            <Logo class="h-7 w-auto" />
          </a>
          <LoginPanel />
        </div>
        <footer class="mt-12 flex items-center gap-5 text-sm opacity-60">
          <a
            href="https://noite.now/"
            target="_blank"
            rel="noopener noreferrer"
            class="link link-hover"
          >
            Docs
          </a>
          <a
            href="https://github.com/ryuzcorp/noite"
            target="_blank"
            rel="noopener noreferrer"
            class="link link-hover"
          >
            GitHub
          </a>
        </footer>
      </main>
    </div>
  );
}
