//! Pure storage naming: no components, no browser APIs, so page server
//! modules (title heads) can import it into the worker.

/** Display name for a storage resource id (mirrors StorageDetail's parsing). */
export const resourceDisplayName = (resourceId: string): string => {
  if (resourceId.startsWith("d1:") || resourceId.startsWith("r2:")) {
    return resourceId.slice(3);
  }
  if (resourceId.startsWith("do:")) {
    return resourceId.split(":").slice(2).join(":");
  }
  return resourceId;
};
