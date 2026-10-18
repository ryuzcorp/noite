//! The app's branch protection rule (F4): one cached resource shared by the
//! settings panel (which writes it) and the source browser's push gate (which
//! reads it to decide whether `main` is protected).
import { tracked } from "../resource";
import { branchRulesGet } from "../server/prs.server";

/** The `require_pr` / `required_approvals` pair for one app. */
export const branchRules = (appId: string) =>
  tracked(`app:${appId}:branch-rules`, () => branchRulesGet({ appId }));
