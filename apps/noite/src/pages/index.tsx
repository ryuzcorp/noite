import { redirect } from "@ilha/router";

/** Home merges into the Apps view — the dashboard had no separate content. */
export default function Home() {
  redirect("/apps");
}
