import { atom, watch } from "ilha";

import { authClient, hardNav } from "./auth-client";

const registrationContext = (email: string, name: string) =>
  JSON.stringify({ email, name });

const sleep = (ms: number) =>
  // oxlint-disable-next-line promise/avoid-new -- browser has no Bun.sleep; setTimeout delay needs a Promise
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Page-load/passkey UX: the auth cookie may not be readable immediately, so poll briefly. */
const waitForSession = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
    const session = await authClient.getSession();
    if (session.data?.user) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
    await sleep(50);
  }
};

/** Passkey register / sign-in. Reloads `/` on success. */
export const LoginPanel = () => {
  const busy = atom(false);
  const error = atom("");
  const mode = atom<"register" | "signin">("register");

  watch.once(() => {
    void (async () => {
      const { data } = await authClient.getSession();
      if (data?.user) {
        hardNav("/");
      }
    })();
  });

  const register = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const name = String(data.get("name") ?? "").trim();
    if (!(email && name)) {
      error.set("Name and email are required");
      return;
    }
    busy.set(true);
    error.set("");
    const result = await authClient.passkey.addPasskey({
      context: registrationContext(email, name),
      createSession: true,
      name: "Primary",
    });
    busy.set(false);
    if (result.error) {
      error.set(result.error.message ?? "Registration failed");
      return;
    }
    if (result.data?.user) {
      // Cookie may not be readable for the very next document request yet.
      await waitForSession();
      hardNav("/");
      return;
    }
    error.set("Registration completed without a session");
  };

  const signIn = async () => {
    busy.set(true);
    error.set("");
    const result = await authClient.signIn.passkey();
    busy.set(false);
    if (result.error) {
      error.set(result.error.message ?? "Sign-in failed");
      return;
    }
    await waitForSession();
    hardNav("/");
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="tabs tabs-box w-fit">
        <button
          type="button"
          class={`tab ${mode() === "register" ? "tab-active" : ""}`}
          onclick={() => {
            mode.set("register");
            error.set("");
          }}
        >
          Register
        </button>
        <button
          type="button"
          class={`tab ${mode() === "signin" ? "tab-active" : ""}`}
          onclick={() => {
            mode.set("signin");
            error.set("");
          }}
        >
          Sign in
        </button>
      </div>

      {mode() === "register" ? (
        <form onsubmit={register} class="flex flex-col gap-3">
          <fieldset class="fieldset">
            <label class="label" for="register-name">
              Name
            </label>
            <input
              id="register-name"
              name="name"
              class="input w-full"
              placeholder="Name"
              autocomplete="name"
              required
            />
          </fieldset>
          <fieldset class="fieldset">
            <label class="label" for="register-email">
              Email
            </label>
            <input
              id="register-email"
              name="email"
              type="email"
              class="input validator w-full"
              placeholder="Email"
              autocomplete="username webauthn"
              required
            />
            <p class="validator-hint hidden">Enter a valid email address</p>
          </fieldset>
          <button type="submit" class="btn btn-primary" disabled={busy()}>
            Create passkey
          </button>
        </form>
      ) : (
        <button
          type="button"
          class="btn btn-primary"
          disabled={busy()}
          onclick={signIn}
        >
          Sign in with passkey
        </button>
      )}

      {error() ? <p class="text-error text-sm">{error()}</p> : null}
    </div>
  );
};
