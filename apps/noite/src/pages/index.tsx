import { authClient, hardNav } from "$lib/auth-client";
import { head } from "@ilha/router";
import { watch } from "ilha";

/** Home resolves by session: signed in → apps, otherwise login. The layout
 * splash covers the check, so this renders nothing itself. */
export default function Home() {
  head({ title: "Noite" });

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      hardNav(data?.user ? "/apps" : "/login");
    })();
  });

  return null;
}
