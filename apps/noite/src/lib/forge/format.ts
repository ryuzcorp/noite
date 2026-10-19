/** Shared forge labels: unix-second timestamps and SHA short forms. */

/** Git stamps are unix seconds; the date helpers take a Date. */
export const gitTime = (seconds: number): Date => new Date(seconds * 1000);

/** The 7-char SHA the UI shows in dense rows. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** Where a sub-page was reached from, so its back link returns to the same
 * checkout: the browsed ref and the open file. Both optional — "" drops the
 * param. */
export interface SourceFrom {
  file: string;
  ref: string;
}

/** The `?ref=&file=` suffix a source-page link carries (`""` when neither is
 * set), so History → commit → back returns to the ref and file it left. */
export const sourceQuery = ({ file, ref }: SourceFrom): string => {
  const params = new URLSearchParams();

  if (ref !== "") {
    params.set("ref", ref);
  }

  if (file !== "") {
    params.set("file", file);
  }

  const query = params.toString();

  return query === "" ? "" : `?${query}`;
};

/** Href for one commit's page, carrying the ref and open file it was opened
 * from so the commit page's back link returns to them. */
export const commitHref = (
  appId: string,
  sha: string,
  from?: SourceFrom
): string =>
  `/apps/${appId}/source/commit/${sha}${from ? sourceQuery(from) : ""}`;

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
