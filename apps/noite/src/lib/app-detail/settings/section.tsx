//! One section of the Settings page: a stable anchor heading and its body.
//! Every section is stacked on `/apps/<id>/settings`; the heading's `id` is
//! what a `?section=` deep link scrolls to, so it must render before (and
//! independently of) the section's own resource.

import type { View } from "ilha";

import { settingsSectionLabel } from "../route.machine";
import type { SettingsSection as SettingsSectionId } from "../route.machine";

/** The DOM id of a section's heading: the anchor `?section=` scrolls to. */
export const settingsSectionAnchor = (section: SettingsSectionId): string =>
  `settings-${section}`;

export const SettingsSection = ({
  actions,
  children,
  section,
}: {
  /** Controls that belong beside the heading (Invite, Download, Add). */
  actions?: View;
  children: View;
  section: SettingsSectionId;
}) => (
  <section
    aria-labelledby={settingsSectionAnchor(section)}
    class="flex w-full flex-col gap-3"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2
        id={settingsSectionAnchor(section)}
        class={`m-0 scroll-mt-4 text-lg font-semibold${
          section === "danger" ? " text-error" : ""
        }`}
      >
        {settingsSectionLabel(section)}
      </h2>
      {actions}
    </div>
    {children}
  </section>
);
