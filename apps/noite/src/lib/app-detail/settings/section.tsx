//! One settings section: the panels carry only their heading and their
//! content. They sit in the Settings side panel, which separates them with
//! dividers rather than a card each (a card per section inside the bordered
//! panel only cost width).

import type { View } from "ilha";

export const SettingsSection = ({ children }: { children: View }) => (
  <section class="flex w-full flex-col gap-4">{children}</section>
);
