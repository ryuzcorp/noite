//! The app's branch protection rule (F4): one cached resource shared by the
//! settings panel (which writes it) and the source browser's push gate (which
//! reads it to decide whether `main` is protected).
import { resource } from "ilha";

import { branchRulesGet } from "../server/prs.server";

/** The `require_pr` / `required_approvals` pair for one app. */
export const branchRules = (appId: string) =>
  resource(`app:${appId}:branch-rules`, () => branchRulesGet({ appId }));
