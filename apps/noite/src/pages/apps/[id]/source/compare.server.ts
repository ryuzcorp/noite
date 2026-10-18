import { defineHead } from "void";

// Base defaults to the platform's default branch (mirrors the page); the
// range refines client-side while its pickers write the query in place.
export const head = defineHead((c) => ({
  title: `Compare ${c.req.query("base") || "main"}…${c.req.query("head") ?? ""} · Noite`,
}));
