import { shortSha } from "$lib/forge/format";
import { defineHead } from "void";

export const head = defineHead((c) => ({
  title: `Commit ${shortSha(c.req.param("sha") ?? "")} · Noite`,
}));
