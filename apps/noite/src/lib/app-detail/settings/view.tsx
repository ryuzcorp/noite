//! Settings page body: fetches the app's own role gate, then stacks every
//! section the role may see on one page — Identity, Domains, Limits, Error
//! reporting, Collaborators, Environment, then Branch protection and Danger
//! zone for admins. There is no tab row: each section is its own heading with
//! a stable anchor (`?section=` scrolls to it, and the compact contents nav
//! links to it), and each panel keeps its own state machine and save flow.
//! The panels are components, so one section's save never touches another's
//! draft, and every section's resource starts loading in the same paint.

import { atom, watch } from "ilha";
import type { View } from "ilha";

import { errorMessage } from "../../errors";
import {
  collectRef,
  liveEl,
  newLiveRef,
  whenFrame,
  whenLive,
} from "../../live-ref";
import { resourceValue, resourceError } from "../../resource";
import { appDetail, invalidate, keys } from "../../resources";
import type { AppRole } from "../../roles";
import { searchParam } from "../../search-param";
import { SectionSkeleton } from "../../ui/skeletons";
import { capabilities } from "../capabilities";
import {
  parseSettingsSection,
  settingsSectionLabel,
  settingsSectionsFor,
} from "../route.machine";
import type { SettingsSection as SettingsSectionId } from "../route.machine";
import { BranchProtectionPanel } from "./branch-protection";
import { CollaboratorsPanel } from "./collaborators";
import { AppDangerZone } from "./danger";
import { CustomDomainsPanel } from "./domains";
import { EnvVarsPanel } from "./env";
import { ErrorReportingPanel } from "./error-reporting";
import { AppIdentityForm } from "./identity";
import { RateLimitsPanel } from "./limits";
import { settingsSectionAnchor } from "./section";

/** What a section renders: the app's own row, gated by the role the server
 * answered with. */
interface SettingsGate {
  readonly appId: string;
  readonly myRole: AppRole;
  readonly name: string;
  readonly slug: string;
  readonly subdomain: string;
}

/** Every section's body, one entry per `SettingsSection` (the `satisfies`
 * makes a new section id a build error until its body is here). The
 * admin-only sections re-check the gate before painting a write form — the
 * page and the URL parser already keep them out of a non-admin's view. */
const SECTION_VIEWS = {
  "branch-protection": (gate) =>
    capabilities(gate.myRole).admin ? (
      <BranchProtectionPanel appId={gate.appId} myRole={gate.myRole} />
    ) : null,
  collaborators: (gate) => (
    <CollaboratorsPanel appId={gate.appId} myRole={gate.myRole} />
  ),
  danger: (gate) =>
    capabilities(gate.myRole).admin ? (
      <AppDangerZone
        appId={gate.appId}
        name={gate.name}
        slug={gate.slug}
        subdomain={gate.subdomain}
        onSaved={() => {
          invalidate(keys.appDetail(gate.appId));
        }}
      />
    ) : null,
  domains: (gate) => (
    <CustomDomainsPanel appId={gate.appId} myRole={gate.myRole} />
  ),
  env: (gate) => <EnvVarsPanel appId={gate.appId} myRole={gate.myRole} />,
  "error-reporting": (gate) => (
    <ErrorReportingPanel appId={gate.appId} myRole={gate.myRole} />
  ),
  identity: (gate) => (
    <AppIdentityForm
      appId={gate.appId}
      name={gate.name}
      myRole={gate.myRole}
      onSaved={() => {
        // invalidate (not res.refetch): the page title and the header
        // dropdown read this key through their own resource cells.
        invalidate(keys.appDetail(gate.appId));
      }}
    />
  ),
  limits: (gate) => <RateLimitsPanel appId={gate.appId} myRole={gate.myRole} />,
} as const satisfies Record<SettingsSectionId, (gate: SettingsGate) => View>;

/** The contents nav sits below the scroll container's top edge and above
 * every heading (`scroll-mt-16` in `section.tsx`): the offset a heading
 * lands on after a deep link, and the line the scroll-spy treats as "this
 * section is now in view". */
const NAV_OFFSET = 64;

/** The nearest ancestor that actually scrolls the sections: `DetailShell`
 * owns it (`overflow-auto`), but the page also renders in tests and short
 * viewports where the body is the scroller. `null` = the document. Resolved
 * once, so it must not depend on the current content height: the sections
 * grow from skeletons into the scrollable layout. */
const scrollParentOf = (el: Element): HTMLElement | null => {
  for (let node = el.parentElement; node; node = node.parentElement) {
    if (node === document.body) {
      return null;
    }

    const { overflowY } = getComputedStyle(node);

    if (overflowY === "auto" || overflowY === "scroll") {
      return node;
    }
  }

  return null;
};

/** Left/Right/Home/End walk the contents strip and scroll the focused tab
 * into view on a narrow screen; Enter/Space activate it like any button. */
const onNavKeyDown = (event: KeyboardEvent): void => {
  if (
    event.currentTarget === null ||
    !(event.currentTarget instanceof HTMLElement)
  ) {
    return;
  }

  const tabs = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(":scope > .tab"),
  ];

  const active = document.activeElement;

  const current =
    active instanceof HTMLButtonElement ? tabs.indexOf(active) : -1;

  if (current === -1) {
    return;
  }

  let next = -1;

  if (event.key === "ArrowRight") {
    next = (current + 1) % tabs.length;
  } else if (event.key === "ArrowLeft") {
    next = (current - 1 + tabs.length) % tabs.length;
  } else if (event.key === "Home") {
    next = 0;
  } else if (event.key === "End") {
    next = tabs.length - 1;
  }

  if (next === -1) {
    return;
  }

  event.preventDefault();
  tabs[next]?.focus();
  tabs[next]?.scrollIntoView({ block: "nearest", inline: "nearest" });
};

/** The stacked sections, their contents nav, and the deep-link scroll. A
 * child component so its `atom`/`watch` slots only exist once the role is
 * known (the panels below need the gate). */
const SettingsSections = ({
  gate,
  sections,
}: {
  gate: SettingsGate;
  sections: readonly SettingsSectionId[];
}) => {
  const rawSection = searchParam("section", { default: "" });
  const isAdmin = capabilities(gate.myRole).admin;
  const anchor = parseSettingsSection(rawSection(), isAdmin);
  const box = atom.lazy(newLiveRef<HTMLDivElement>)();
  // A contents-nav pick owns the scroll from that point on: the deep-link
  // scroll below must never pull the viewport back to the section the page
  // opened on.
  const jumped = atom(false);
  // The section whose heading is at (or above) the nav line. The nav paints
  // it as the active tab; scrolling the body moves it, a pick sets it at
  // once so the indicator never lags the click.
  const activeSection = atom<SettingsSectionId>(anchor ?? sections[0]);

  // A shared link (`?section=domains`, or the old `?panel=settings` redirect)
  // opens on that section. Sections above the target grow as their own
  // resources answer, so the heading keeps moving; re-align it on every DOM
  // change until no section is a skeleton anymore (no `role=status`), which
  // is the settled layout.
  watch.once(async ({ signal }) => {
    if (typeof window === "undefined" || anchor === null) {
      return;
    }

    const host = await whenLive(box, signal);
    const headingId = `#${settingsSectionAnchor(anchor)}`;

    const first = host
      ? await whenFrame(() => host.querySelector(headingId), signal)
      : null;

    if (!host || !first || signal.aborted) {
      return;
    }

    first.scrollIntoView({ block: "start" });

    const settled = (): boolean =>
      host.querySelector('[role="status"]') === null;

    if (settled()) {
      return;
    }

    let observer: MutationObserver | null = null;

    const follow = (): void => {
      if (jumped()) {
        observer?.disconnect();

        return;
      }

      host.querySelector(headingId)?.scrollIntoView({ block: "start" });

      if (settled()) {
        observer?.disconnect();
      }
    };

    observer = new MutationObserver(follow);
    observer.observe(host, { childList: true, subtree: true });
    signal.addEventListener("abort", () => observer?.disconnect(), {
      once: true,
    });
  });

  // Scroll-spy: the tab strip (sticky above the sections) marks the section
  // whose heading has crossed the nav line. The IntersectionObserver only
  // says *when* to re-measure — a heading entering or leaving the band below
  // the nav, or the page being scrolled for any reason — and the measure
  // itself picks the last heading at/above that line, so a leap (click,
  // deep link, keyboard End) lands correctly in one pass.
  watch.once(async ({ onCleanup, signal }) => {
    if (typeof window === "undefined") {
      return;
    }

    const host = await whenLive(box, signal);

    if (!host || signal.aborted) {
      return;
    }

    const root = scrollParentOf(host);

    const headings = sections.flatMap((section) => {
      const heading = host.querySelector<HTMLElement>(
        `#${settingsSectionAnchor(section)}`
      );

      return heading === null ? [] : [{ heading, section }];
    });

    if (headings.length === 0) {
      return;
    }

    // A shared link starts on its section; until its heading has actually
    // landed under the nav the page is still at the top, and the spy must
    // not flash the first section's marker. A pick or the landing ends the
    // wait.
    let anchorLanded = anchor === null;

    const sync = (): void => {
      const top = root === null ? 0 : root.getBoundingClientRect().top;
      const line = NAV_OFFSET + 1;

      if (!anchorLanded && !jumped() && anchor !== null) {
        const heading = headings.find(
          (entry) => entry.section === anchor
        )?.heading;

        const landed =
          heading !== undefined &&
          heading.getBoundingClientRect().top - top <= line;

        if (!landed) {
          if (activeSection() !== anchor) {
            activeSection.set(anchor);
          }

          return;
        }

        anchorLanded = true;
      }

      const [firstSection] = sections;
      let next = firstSection;

      for (const { heading, section } of headings) {
        if (heading.getBoundingClientRect().top - top <= line) {
          next = section;
        }
      }

      const atEnd =
        root === null
          ? window.scrollY + window.innerHeight >=
            document.documentElement.scrollHeight - 2
          : root.scrollTop + root.clientHeight >= root.scrollHeight - 2;

      const final = (atEnd ? sections.at(-1) : next) ?? next;

      if (activeSection() !== final) {
        activeSection.set(final);
      }
    };

    const observer = new IntersectionObserver(
      () => {
        sync();
      },
      {
        root,
        // The heading band starts just inside the sticky nav (a heading that
        // lands on `scroll-mt-16` is inside it, not exactly on the edge) and
        // ends well above the fold: crossing either edge re-measures.
        rootMargin: `-${NAV_OFFSET - 8}px 0px -55% 0px`,
        threshold: 0,
      }
    );

    for (const { heading } of headings) {
      observer.observe(heading);
    }

    // Scrolling is the steady-state trigger; the observer only catches a
    // heading entering or leaving the band (a pick or deep-link leap, which
    // the scroll events also see). The signal tears the listener down with
    // the component.
    (root ?? window).addEventListener("scroll", sync, {
      passive: true,
      signal,
    });

    // A deep link is still scrolling sections into place; `sync` keeps the
    // linked section marked until its heading lands, so this first measure
    // is safe either way.
    sync();

    onCleanup(() => {
      observer.disconnect();
    });
    signal.addEventListener("abort", () => observer.disconnect(), {
      once: true,
    });
  });

  const jump = (section: SettingsSectionId): void => {
    jumped.set(true);
    activeSection.set(section);
    rawSection.set(section);
    liveEl(box)
      ?.querySelector(`#${settingsSectionAnchor(section)}`)
      ?.scrollIntoView({ block: "start" });
  };

  return (
    <div class="flex w-full max-w-3xl flex-col gap-6">
      <nav
        aria-label="Settings sections"
        class="bg-base-200 dark:bg-base-100 border-base-300 sticky top-0 z-10 -mx-4 border-b px-4 pt-2"
      >
        {/* One row on every width: a narrow screen scrolls the strip
            sideways instead of stacking it, and the sticky bar keeps the
            active tab reachable while the sections scroll under it. */}
        <div class="overflow-x-auto">
          <div
            class="tabs tabs-border w-max flex-nowrap"
            onkeydown={onNavKeyDown}
          >
            {sections.map((section) => {
              const current = activeSection() === section;

              return (
                <button
                  key={section}
                  type="button"
                  class={`tab whitespace-nowrap${current ? " tab-active" : ""}`}
                  aria-current={current ? "location" : undefined}
                  onclick={() => {
                    jump(section);
                  }}
                >
                  {settingsSectionLabel(section)}
                </button>
              );
            })}
          </div>
        </div>
      </nav>
      <div ref={(el) => collectRef(box, el)} class="flex flex-col gap-10">
        {sections.map((section) => SECTION_VIEWS[section](gate))}
      </div>
    </div>
  );
};

/** The app's whole Settings page. Fetches its own role gate so it stays
 * independent of any other page's fetch (the same `appDetail` resource, so
 * this is never a second request). */
export const AppSettingsView = ({ appId }: { appId: string }) => {
  const res = appDetail(appId);
  const info = resourceValue(res.state());

  if (res.state()._tag === "Loading") {
    return <SectionSkeleton lines={4} />;
  }

  const loadError = resourceError(res.state());

  if (loadError && !info) {
    return <p class="text-error m-0 text-sm">{errorMessage(loadError)}</p>;
  }

  if (!info) {
    return null;
  }

  return (
    <SettingsSections
      gate={{
        appId: info.app.id,
        myRole: info.myRole,
        name: info.app.name,
        slug: info.app.slug,
        subdomain: info.app.subdomain,
      }}
      sections={settingsSectionsFor(capabilities(info.myRole).admin)}
    />
  );
};
