import { defineHead } from "void";

export const head = defineHead((c) => ({
  title: `Pull request #${c.req.param("number") ?? ""} · Noite`,
}));
