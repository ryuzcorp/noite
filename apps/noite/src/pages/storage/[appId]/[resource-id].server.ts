import { resourceDisplayName } from "$lib/storage/names";
import { defineHead } from "void";

export const head = defineHead((c) => {
  const resourceId = c.req.param("resource-id") ?? "";

  return {
    title: `${resourceId ? resourceDisplayName(resourceId) : "Storage"} · Noite`,
  };
});
