//! The card every settings panel sits in: one section wrapping a padded
//! `card-body`, so the panels carry only their heading and their content.

import type { View } from "ilha";

export const SettingsSection = ({ children }: { children: View }) => (
  <section class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md">
    <div class="card-body gap-4">{children}</div>
  </section>
);
