import { head, navigate } from "@ilha/router";
import { watch } from "ilha";

/** Old URL for the account page: keep bookmarks and older CLI/docs hints
 * working by forwarding to /account (replace, so Back skips it). */
export default function ProfileRedirect() {
  head({ title: "Account · Noite" });
  watch.once(() => {
    navigate("/account", { replace: true });
  });
  return null;
}
