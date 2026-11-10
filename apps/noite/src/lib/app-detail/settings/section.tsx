//! One settings section: the panels carry only their heading and their
//! content. They are the sub-navigation of the Settings view
//! (`/apps/<id>/settings?section=…`), one section shown at a time at the
//! page's own width — the wrapper keeps the section's own spacing.

import type { View } from "ilha";

export const SettingsSection = ({ children }: { children: View }) => (
  <section class="flex w-full flex-col gap-4">{children}</section>
);
