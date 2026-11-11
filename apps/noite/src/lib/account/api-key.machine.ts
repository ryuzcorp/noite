//! The API-key create form, as one value. Two booleans allowed "neither
//! scope", a state only the server rejected (after a round trip) while the
//! Create button stayed enabled; this union cannot represent it, and
//! `toggleScope` refuses to turn off the last one instead of silently
//! producing the illegal state.
//!
//! The whole draft — scopes, app set, role ceiling, expiry — is one
//! `KeyDraft` with pure transitions, so the form cannot hold a combination the
//! server would reject for reasons the client could have known (an empty app
//! set, a ceiling below what an ingest key needs).
import { Data } from "effect";

import { EXPIRY_PRESETS } from "../key-principal";
import type { ExpiryPreset } from "../key-principal";
import { roleAtLeast } from "../roles";
import type { AppRole } from "../roles";

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

/** The two machine scope flags the key gets. */
export interface ScopeInput {
  readonly appManagement: boolean;
  readonly events: boolean;
}

export const scopeInput = (scope: KeyScope): ScopeInput => {
  const selection = scopeSelection(scope);

  return { appManagement: selection.apps, events: selection.events };
};

/** The request the create action takes. */
export interface CreateKeyInput extends ScopeInput {
  readonly appIds: readonly string[] | null;
  readonly expirySeconds: number | null;
  readonly name: string;
  readonly roleCeiling: AppRole;
}

/** Everything the create dialog edits, as one value. `appIds` is `null` for
 * account-wide (the same "no restriction" a key with no metadata has). */
export interface KeyDraft {
  readonly appIds: readonly string[] | null;
  readonly ceiling: AppRole;
  readonly expiry: ExpiryPreset;
  readonly scope: KeyScope;
}

/** A new key: both machine scopes, every app, no ceiling and no expiry —
 * exactly what the pre-scope form minted, so the default changes nothing. */
export const newKeyDraft = (): KeyDraft => ({
  appIds: null,
  ceiling: "admin",
  expiry: "never",
  scope: KeyScopes.Both(),
});

export const withScope = (draft: KeyDraft, scope: KeyScope): KeyDraft => ({
  ...draft,
  scope,
});

export const withCeiling = (draft: KeyDraft, ceiling: AppRole): KeyDraft => ({
  ...draft,
  ceiling,
});

export const withExpiry = (
  draft: KeyDraft,
  expiry: ExpiryPreset
): KeyDraft => ({ ...draft, expiry });

/** Toggle one app's membership. From account-wide, unchecking one app starts
 * an explicit selection of every other app (so "all" keeps meaning "all");
 * re-checking the last missing one goes back to account-wide, so a key never
 * pins a list that a new app would silently fall out of. */
export const toggleApp = (
  draft: KeyDraft,
  appId: string,
  on: boolean,
  everyAppId: readonly string[]
): KeyDraft => {
  if (draft.appIds === null) {
    return on
      ? draft
      : { ...draft, appIds: everyAppId.filter((id) => id !== appId) };
  }

  const next = on
    ? [...new Set([...draft.appIds, appId])]
    : draft.appIds.filter((id) => id !== appId);

  const coversEverything =
    next.length === everyAppId.length &&
    everyAppId.every((id) => next.includes(id));

  return { ...draft, appIds: coversEverything ? null : next };
};

/** Why the draft cannot be submitted yet, or null. The server re-checks all
 * of it; this is what keeps the button honest. */
export const draftProblem = (draft: KeyDraft): string | null => {
  if (draft.appIds !== null && draft.appIds.length === 0) {
    return "Pick at least one app, or leave the key account-wide";
  }

  if (
    scopeSelection(draft.scope).events &&
    !roleAtLeast(draft.ceiling, "push")
  ) {
    return "Event ingest needs the push role or a higher ceiling";
  }

  return null;
};

/** The create action's body for this draft. */
export const createKeyBody = (
  draft: KeyDraft,
  name: string
): CreateKeyInput => ({
  ...scopeInput(draft.scope),
  appIds: draft.appIds === null ? null : [...draft.appIds],
  expirySeconds: EXPIRY_PRESETS[draft.expiry],
  name: name.trim(),
  roleCeiling: draft.ceiling,
});
