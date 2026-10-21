import type { RunnerUpdateStatus } from "../runner";

/** Whether the banner shows: admins only, the check on, a newer release
 * seen, and not dismissed for that version. The runner only reports
 * `latest` when it is newer than `current`. */
export const shouldShowUpdateBanner = (
  status: RunnerUpdateStatus | undefined,
  isAdmin: boolean,
  dismissedVersion: string | null
): boolean =>
  isAdmin &&
  (status?.enabled ?? false) &&
  status?.latest !== undefined &&
  status?.latest !== null &&
  status.latest !== dismissedVersion;
