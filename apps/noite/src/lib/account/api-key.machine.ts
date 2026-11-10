//! The API-key scope choice, as one value. Two booleans allowed "neither
//! scope", a state only the server rejected (after a round trip) while the
//! Create button stayed enabled; this union cannot represent it, and
//! `toggleScope` refuses to turn off the last one instead of silently
//! producing the illegal state.
import { Data } from "effect";

/** Which machine scopes a new key gets. */
export type KeyScope = Data.TaggedEnum<{
  Apps: Record<never, never>;
  Both: Record<never, never>;
  Events: Record<never, never>;
}>;

export const KeyScopes = Data.taggedEnum<KeyScope>();

export type ScopeName = "apps" | "events";

/** What each checkbox shows. */
export const scopeSelection = (
  scope: KeyScope
): Record<ScopeName, boolean> => ({
  apps: scope._tag !== "Events",
  events: scope._tag !== "Apps",
});

/** Turn one scope on or off, keeping at least one selected: turning off the
 * last checked box is a no-op (the UI also disables that click). */
export const toggleScope = (
  scope: KeyScope,
  which: ScopeName,
  on: boolean
): KeyScope => {
  const next = scopeSelection(scope);

  if (!on && next[which] && next.apps !== next.events) {
    // Turning off the only checked one.
    return scope;
  }

  next[which] = on;

  if (next.apps && next.events) {
    return KeyScopes.Both();
  }

  return next.apps ? KeyScopes.Apps() : KeyScopes.Events();
};

/** The request fields the create action takes. */
export interface CreateKeyInput {
  readonly appManagement: boolean;
  readonly events: boolean;
}

export const scopeInput = (scope: KeyScope): CreateKeyInput => {
  const selection = scopeSelection(scope);

  return { appManagement: selection.apps, events: selection.events };
};
