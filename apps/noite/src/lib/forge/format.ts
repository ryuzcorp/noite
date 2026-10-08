/** Shared forge labels: unix-second timestamps and SHA short forms. */

/** Git stamps are unix seconds; the date helpers take a Date. */
export const gitTime = (seconds: number): Date => new Date(seconds * 1000);

/** The 7-char SHA the UI shows in dense rows. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Href for one commit's page. */
export const commitHref = (appId: string, sha: string): string =>
  `/apps/${appId}/source/commit/${sha}`;

/** Ahead/behind label vs main, or null when the branch is level. */
export const divergeLabel = (ahead: number, behind: number): string | null => {
  const parts: string[] = [];
  if (ahead > 0) {
    parts.push(`${ahead} ahead`);
  }
  if (behind > 0) {
    parts.push(`${behind} behind`);
  }
  return parts.length === 0 ? null : parts.join(", ");
};
