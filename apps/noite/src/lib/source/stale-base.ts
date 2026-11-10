//! The one place the checkout's staleness is named: the pod's work is based on
//! `baseSha`, while the browsed ref's tip is `tipSha`. `Workspace.stale` holds
//! the *tip* (it is what the checkout is compared against), and the panel used
//! to publish the pod's base under that same name — so the banner's "based on"
//! commit and the "tip moved on" fact were two different values behind one
//! word. Both are carried here, and nothing else may reconstruct them.

/** A checkout whose pod is based on a commit the browsed tip has moved past. */
export interface StaleBase {
  /** The commit the pod's files were checked out from (what the Changes panel
   * names as "based on"). */
  readonly baseSha: string;
  /** The browsed ref's resolved tip: the commit the branch now has. */
  readonly tipSha: string;
}

/** Derive the staleness, or null when the pod is on the browsed tip. A move
 * without a new tip (`stale === null`) is not staleness: the pod replaced
 * itself. */
export const staleBase = (
  tip: string | null,
  baseSha: string
): StaleBase | null => (tip === null ? null : { baseSha, tipSha: tip });
