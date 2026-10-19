import { fetchSession } from "$lib/auth/session";
import { useRouter } from "@ilha/void";
import { watch } from "ilha";

/** Home resolves by session: signed in → apps, otherwise login. The layout
 * splash covers the check, so this renders nothing itself. The title comes
 * from `index.server.ts`. */
export default function Home() {
  const router = useRouter();

  watch.once(async () => {
    if (typeof window === "undefined") {
      return;
    }

    const { data } = await fetchSession();
    await router.visit(data?.user ? "/apps" : "/login");
  });

  return null;
}
