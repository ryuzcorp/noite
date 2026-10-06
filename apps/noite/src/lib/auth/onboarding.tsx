//! First-run onboarding modal. Mounted once in the authed layout; shows
//! while the session account has never finished (user.onboardedAt is NULL)
//! and the session is not an impersonated one. Finishing, skipping or closing
//! (Esc/backdrop) marks the account onboarded (the action is idempotent) and
//! drops the cached session so the tour cannot come back on a later SPA
//! navigation. The tour has no navigating links: steps 1 and 2 spotlight the
//! sidebar item they describe (`data-tour` in pages/+layout.tsx) instead.
import * as Atom from "effect/reactivity/Atom";
import { atom, watch } from "ilha";
import type { View } from "ilha";

import { session } from "../resources";
import type { SessionView } from "../resources";
import { completeOnboarding } from "../server/account.server";
import { Dialog } from "../ui/dialog";
import {
  ArrowLeft,
  ArrowUpRight,
  CloudUpload,
  Heart,
  Key,
  MessageCircle,
  Star,
  X,
} from "../ui/icons";
import { invalidateSession } from "./session";

const GITHUB_URL = "https://github.com/ryuzcorp/noite";
const DISCORD_URL = "https://discord.gg/WnVTMCTz74";
const SPONSOR_URL = "https://github.com/sponsors/ryuzdev";

const STEP_COUNT = 3;
const LAST_STEP = STEP_COUNT - 1;

/** `data-tour` target each step spotlights in the sidebar (none on the last).
 * The dialog sits in the top layer, so the spotlight is drawn inside it: a
 * ring over the target whose huge box-shadow dims everything else. */
const TOUR_TARGETS = ["apps", "account", null] as const;
/** Breathing room between the target and the spotlight ring, in px. */
const SPOT_PAD = 6;
/** daisyUI's drawer hides its side with a delayed visibility/translate
 * transition (100 ms + 300 ms); re-measure once it has settled. */
const DRAWER_SETTLE_MS = 450;

/** Large tinted icon tile that leads each step. */
const StepIcon = ({ children }: { children: View }) => (
  <div class="bg-base-200 dark:bg-base-300 flex h-12 w-12 items-center justify-center rounded-2xl">
    {children}
  </div>
);

/** One outbound row on the last step: icon, label, hint, external arrow. */
const LinkRow = ({
  hint,
  href,
  icon,
  id,
  label,
  emphasis,
}: {
  hint: string;
  href: string;
  icon: View;
  id: string;
  label: string;
  /** Draws the row a notch stronger (the sponsor ask). */
  emphasis?: boolean;
}) => (
  <a
    id={id}
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    class={`hover:bg-base-200 dark:hover:bg-base-300 flex items-center gap-3 rounded-xl border p-3 no-underline transition-colors ${emphasis ? "border-base-content/30" : "border-base-300"}`}
  >
    <span
      class={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${emphasis ? "bg-neutral text-neutral-content" : "bg-base-200 dark:bg-base-300"}`}
    >
      {icon}
    </span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span class="text-sm font-medium">{label}</span>
      <span class="text-xs opacity-60">{hint}</span>
    </span>
    <ArrowUpRight class="shrink-0 opacity-40" />
  </a>
);

export const Onboarding = () => {
  const res = session();
  // Derived from the session resource, so it also corrects itself if the
  // session arrives after mount or changes under the mounted layout.
  const show = atom(
    Atom.map(
      (value: SessionView | null | undefined): boolean =>
        value?.user !== undefined &&
        value.user.onboardedAt === null &&
        !value.session.impersonatedBy
    )(res.data.atom)
  );
  const open = atom(show());
  const step = atom(0);
  const closed = atom(false);
  // Viewport rect of the sidebar item the current step points at, or null
  // when the step has none or it isn't on screen (mobile: the sidebar is in
  // the closed drawer).
  const spot = atom<DOMRect | null>(null);

  const measure = () => {
    const target = TOUR_TARGETS[step()];
    const el = target
      ? document.querySelector(`[data-tour="${target}"]`)
      : null;
    // The closed mobile drawer hides the sidebar with visibility/opacity, so
    // its items keep a real rect: ask for actual visibility too.
    const visible =
      el?.checkVisibility({
        opacityProperty: true,
        visibilityProperty: true,
      }) ?? false;
    const rect = visible ? el?.getBoundingClientRect() : undefined;
    const onScreen =
      rect !== undefined &&
      rect.width > 0 &&
      rect.height > 0 &&
      rect.right > 0 &&
      rect.left < window.innerWidth;
    spot.set(onScreen ? rect : null);
  };
  watch(step, () => {
    measure();
  });
  watch(open, (isOpen, { onCleanup, signal }) => {
    if (!isOpen) {
      spot.set(null);
      return;
    }
    // Measure once the dialog is up, and again whenever the layout moves —
    // right away and after the drawer's transition settles (a resize into
    // the mobile layout hides the sidebar only after that transition).
    requestAnimationFrame(measure);
    let settle = 0;
    window.addEventListener(
      "resize",
      () => {
        measure();
        window.clearTimeout(settle);
        settle = window.setTimeout(measure, DRAWER_SETTLE_MS);
      },
      { signal }
    );
    onCleanup(() => {
      window.clearTimeout(settle);
    });
  });

  // Once the user has dismissed the tour this mount, never reopen it — even
  // while the stale session snapshot still says onboardedAt is NULL.
  watch(show, (value) => {
    if (!closed()) {
      open.set(value);
    }
  });

  const finish = async (): Promise<void> => {
    if (closed()) {
      return;
    }
    closed.set(true);
    try {
      await completeOnboarding();
    } catch {
      // A failed write must not trap the user in the modal; worst case the
      // tour shows again on the next load.
    }
    open.set(false);
    // The session snapshot still says onboardedAt is NULL. Drop every
    // user-scoped cache so the next read sees the marked account and the
    // modal never reopens on an SPA navigation.
    invalidateSession();
  };

  return (
    <Dialog
      open={open}
      class={`modal modal-bottom sm:modal-middle ${spot() ? "onboarding-spotlit" : ""}`}
      labelledBy="onboarding-title"
      onClose={() => {
        void finish();
      }}
    >
      {spot() ? (
        <span
          class="onboarding-spotlight pointer-events-none fixed z-0 rounded-xl"
          style={`top:${(spot()?.top ?? 0) - SPOT_PAD}px;left:${(spot()?.left ?? 0) - SPOT_PAD}px;width:${(spot()?.width ?? 0) + SPOT_PAD * 2}px;height:${(spot()?.height ?? 0) + SPOT_PAD * 2}px`}
          aria-hidden="true"
        />
      ) : null}
      <div
        class="modal-box bg-base-100 dark:bg-base-200 relative z-10 flex max-w-md flex-col gap-6 p-6 sm:rounded-2xl"
        onkeydown={(event: KeyboardEvent) => {
          // Arrow keys page through the tour, like stories.
          if (event.key === "ArrowRight" && step() < LAST_STEP) {
            step.set(step() + 1);
          } else if (event.key === "ArrowLeft" && step() > 0) {
            step.set(step() - 1);
          }
        }}
      >
        <div class="flex items-center gap-3">
          <div
            class="flex flex-1 gap-1.5"
            role="progressbar"
            aria-label="Tour progress"
            aria-valuemin={1}
            aria-valuemax={STEP_COUNT}
            aria-valuenow={step() + 1}
          >
            {[0, 1, 2].map((index) => (
              <span
                class={`h-1 flex-1 rounded-full transition-colors duration-300 ${index <= step() ? "bg-base-content" : "bg-base-content/15"}`}
              />
            ))}
          </div>
          <button
            id="onboarding-skip"
            type="button"
            class="btn btn-ghost btn-sm btn-circle -mr-2"
            aria-label="Skip tour"
            onclick={() => {
              void finish();
            }}
          >
            <X />
          </button>
        </div>

        {/* Fixed minimum height (the tallest step) so the footer doesn't
            jump as the tour advances. */}
        <div class="min-h-[23rem]">
          {step() === 0 ? (
            <div class="onboarding-step flex flex-col gap-4">
              <StepIcon>
                <CloudUpload size={24} />
              </StepIcon>
              <div class="flex flex-col gap-2">
                <h2 id="onboarding-title" class="m-0 text-xl font-semibold">
                  Push to deploy
                </h2>
                <p class="m-0 text-sm leading-relaxed opacity-70">
                  Your apps live under <strong>Apps</strong> in the sidebar.
                  Each one gets a Git remote: push to it and Noite builds and
                  serves it on its own subdomain.
                </p>
              </div>
              <pre class="bg-base-200 dark:bg-base-300 m-0 overflow-x-auto rounded-xl px-4 py-3 font-mono text-xs leading-relaxed">
                <span class="opacity-50">$ </span>git push noite main{"\n"}
                <span class="opacity-50">→ </span>https://
                <span class="font-semibold">your-app</span>.your-domain
              </pre>
            </div>
          ) : null}

          {step() === 1 ? (
            <div class="onboarding-step flex flex-col gap-4">
              <StepIcon>
                <Key size={24} />
              </StepIcon>
              <div class="flex flex-col gap-2">
                <h2 id="onboarding-title" class="m-0 text-xl font-semibold">
                  One key for Git and CLI
                </h2>
                <p class="m-0 text-sm leading-relaxed opacity-70">
                  Create an API key from your avatar → <strong>Account</strong>,
                  with the App Management scope. It's your Git password and your
                  CLI token.
                </p>
              </div>
              <dl class="bg-base-200 dark:bg-base-300 m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-xl px-4 py-3 font-mono text-xs">
                <dt class="opacity-50">git user</dt>
                <dd class="m-0">git</dd>
                <dt class="opacity-50">git password</dt>
                <dd class="m-0">your API key</dd>
                <dt class="opacity-50">CLI</dt>
                <dd class="m-0">NOITE_API_KEY=…</dd>
              </dl>
            </div>
          ) : null}

          {step() === 2 ? (
            <div class="onboarding-step flex flex-col gap-4">
              <StepIcon>
                <Heart size={24} />
              </StepIcon>
              <div class="flex flex-col gap-2">
                <h2 id="onboarding-title" class="m-0 text-xl font-semibold">
                  Stay in the loop
                </h2>
                <p class="m-0 text-sm leading-relaxed opacity-70">
                  Releases list the operator actions an upgrade needs. Watch
                  them so nothing surprises you.
                </p>
              </div>
              <div class="flex flex-col gap-2">
                <LinkRow
                  id="onboarding-github"
                  href={GITHUB_URL}
                  icon={<Star />}
                  label="Star & watch on GitHub"
                  hint="Release notes and upgrade steps"
                />
                <LinkRow
                  id="onboarding-discord"
                  href={DISCORD_URL}
                  icon={<MessageCircle />}
                  label="Join the Discord"
                  hint="Questions, feedback, show and tell"
                />
                <LinkRow
                  id="onboarding-sponsor"
                  href={SPONSOR_URL}
                  icon={<Heart />}
                  label="Sponsor on GitHub"
                  hint="Keeps Noite maintained"
                  emphasis
                />
              </div>
            </div>
          ) : null}
        </div>

        <div class="flex items-center justify-between gap-3">
          {step() > 0 ? (
            <button
              id="onboarding-back"
              type="button"
              class="btn btn-ghost"
              onclick={() => {
                step.set(step() - 1);
              }}
            >
              <ArrowLeft />
              Back
            </button>
          ) : (
            <span />
          )}
          {step() < LAST_STEP ? (
            <button
              id="onboarding-next"
              autofocus
              type="button"
              class="btn btn-neutral min-w-28"
              onclick={() => {
                step.set(step() + 1);
              }}
            >
              Next
            </button>
          ) : (
            <button
              id="onboarding-finish"
              autofocus
              type="button"
              class="btn btn-neutral min-w-28"
              onclick={() => {
                void finish();
              }}
            >
              Get started
            </button>
          )}
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button aria-label="Close onboarding">close</button>
      </form>
    </Dialog>
  );
};
