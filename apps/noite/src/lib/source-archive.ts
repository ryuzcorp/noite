/** The branch's full checkout as an uncompressed tar, for the Code-mode
 * Workspace (the pod FS untars it into `/home/project`). The runner caps a
 * checkout at 5000 files / 100 MiB and answers 413 with a readable message
 * above that. */
export const fetchSourceArchive = async (
  appId: string,
  ref: string
): Promise<Uint8Array> => {
  const query = new URLSearchParams({ ref });

  const res = await fetch(
    `/api/apps/${encodeURIComponent(appId)}/source/archive?${query}`
  );

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`archive failed: ${res.status} ${text}`);
  }

  return new Uint8Array(await res.arrayBuffer());
};
