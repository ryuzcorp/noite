//! Which tab saves the workspace, as one state.

import { Data } from "effect";

/** The tab's role in the saved copy.
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> booting
 *   booting --> readonly: a ref that is not editable
 *   booting --> following: the boot was refused the lock
 *   booting --> saving: the boot took the lock
 *   following --> taking-over: the lock was granted
 *   taking-over --> saving: the flush landed
 *   saving --> following: the lock was lost
 *   taking-over --> following: the lock was lost
 *   readonly --> closed: close
 *   following --> closed: close
 *   taking-over --> closed: close
 *   saving --> closed: close
 * ```
 *
 * `saving` is the single tab that writes IndexedDB; `following` restores it,
 * stays editable and queues for the lock; `taking-over` has the lock and is
 * flushing what it owes before `saving`. A tab that loses the lock goes back to
 * `following` — it keeps editing, but its saves are refused *and reported*,
 * which is the one thing the old `onLost: null` could not do. */
export type TabRole = Data.TaggedEnum<{
  /** The boot is in flight: no role yet. */
  Booting: Record<never, never>;
  Closed: Record<never, never>;
  Following: Record<never, never>;
  Readonly: Record<never, never>;
  Saving: Record<never, never>;
  TakingOver: Record<never, never>;
}>;

export type RoleEvent =
  | { t: "boot-following" }
  | { t: "boot-readonly" }
  | { t: "boot-saving" }
  | { t: "close" }
  | { t: "granted" }
  | { t: "lock-lost" }
  | { t: "took-over" };

export const Role = Data.taggedEnum<TabRole>();

/** Whether this tab may commit the saved copy. One function, so the store's
 * gate, the error reporting and the boot all agree. */
export const maySave = (role: TabRole): boolean =>
  Role.$match(role, {
    Booting: () => false,
    Closed: () => false,
    Following: () => false,
    Readonly: () => false,
    Saving: () => true,
    TakingOver: () => true,
  });

/** The one role transition. */
export const roleTransition = (role: TabRole, event: RoleEvent): TabRole => {
  if (event.t === "close") {
    return Role.Closed();
  }

  return Role.$match(role, {
    Booting: () => {
      switch (event.t) {
        case "boot-following": {
          return Role.Following();
        }

        case "boot-readonly": {
          return Role.Readonly();
        }

        case "boot-saving": {
          return Role.Saving();
        }

        default: {
          return role;
        }
      }
    },
    Closed: () => role,
    Following: () => {
      switch (event.t) {
        case "granted": {
          return Role.TakingOver();
        }

        case "boot-following": {
          return role;
        }

        default: {
          return role;
        }
      }
    },
    Readonly: () => role,
    Saving: () => (event.t === "lock-lost" ? Role.Following() : role),
    TakingOver: () => {
      switch (event.t) {
        case "lock-lost": {
          return Role.Following();
        }

        case "took-over": {
          return Role.Saving();
        }

        default: {
          return role;
        }
      }
    },
  });
};

/** The message a tab that lost the lock reports: it is still editable, and
 * nothing it does is being kept. */
export const LOST_LOCK_MESSAGE =
  "Another tab took over saving this workspace: your edits here are not being saved. Reload this tab to keep editing.";
