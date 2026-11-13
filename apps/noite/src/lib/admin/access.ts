//! Client-side read of instance authority for surfaces outside the admin page
//! (the update banner, the Account header's role badge). The admin page and
//! the side bar read `mayAdministerInstance(overviewAuthority(…))` directly;
//! this is the same one predicate behind the cached `adminStatus()` read, so
//! no surface invents its own rule. Presentation only: every action and
//! stream behind these surfaces re-checks server-side.

import { mayAdministerInstance, overviewAuthority } from "../authority";
import { resourceValue } from "../resource";
import { adminStatus } from "../resources";

/** May this session administer the instance? Never while impersonating and
 * never before the overview answers. */
export const isInstanceAdmin = (): boolean =>
  mayAdministerInstance(
    overviewAuthority(resourceValue(adminStatus().state()))
  );
