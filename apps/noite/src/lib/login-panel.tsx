import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";

import { authClient } from "./auth-client";
import { fetchSession } from "./session";
import { sleep } from "./sleep";

const registrationContext = (email: string, name: string, invite: string) =>
  JSON.stringify({ email, invite, name });

/** Public policy from `/api/invite/status`: the first account on a fresh
 * instance bootstraps it, so only later ones need a code. */
interface SignupPolicy {
  firstRun: boolean;
  invitesPerUser: number;
  requiresInvite: boolean;
}

const fetchSignupPolicy = async (): Promise<SignupPolicy> => {
  try {
    const res = await fetch("/api/invite/status");
    if (res.ok) {
      // SAFETY: the route answers exactly this shape (see handleInviteStatus).
      return (await res.json()) as SignupPolicy;
    }
  } catch {
    // Fall through to the stricter default below.
  }
  return { firstRun: false, invitesPerUser: 0, requiresInvite: true };
};

/** Page-load/passkey UX: the auth cookie may not be readable immediately, so poll briefly. */
const waitForSession = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
    const session = await fetchSession({ force: true });
    if (session.data?.user) {
      return;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
    await sleep(50);
  }
};

/** Passkey register / sign-in. Navigates to `/apps` on success (SPA —
 * the session cookie is verified readable before leaving, so the gate
 * revalidates instantly with no document reload). Email OTP stays
 * behind "Lost passkey?" — recovery for passkey-less devices, not primary. */
export const LoginPanel = () => {
  const busy = atom(false);
  const error = atom("");
  const mode = atom<"register" | "signin">("register");
  const recovery = atom(false);
  const otpSent = atom(false);
  const otpEmail = atom("");
  const invite = atom<SignupPolicy | null>(null);

  watch.once(() => {
    void (async () => {
      invite.set(await fetchSignupPolicy());
      const { data } = await fetchSession();
      if (data?.user) {
        navigate("/apps");
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
    const code = String(data.get("invite") ?? "").trim();
    if (!(email && name)) {
      error.set("Name and email are required");
      return;
    }
    if (invite()?.requiresInvite && !code) {
      error.set("An invitation code is required on this instance");
      return;
    }
    busy.set(true);
    error.set("");
    const result = await authClient.passkey.addPasskey({
      context: registrationContext(email, name, code),
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
      navigate("/apps");
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
    navigate("/apps");
  };

  const sendOtp = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const email = String(new FormData(form).get("email") ?? "").trim();
    if (!email) {
      error.set("Email is required");
      return;
    }
    busy.set(true);
    error.set("");
    const result = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: "sign-in",
    });
    busy.set(false);
    if (result.error) {
      error.set(result.error.message ?? "Failed to send code");
      return;
    }
    otpEmail.set(email);
    otpSent.set(true);
  };

  const verifyOtp = async (event: SubmitEvent) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!(form instanceof HTMLFormElement)) {
      return;
    }
    const otp = String(new FormData(form).get("otp") ?? "").trim();
    if (!otp) {
      error.set("Code is required");
      return;
    }
    busy.set(true);
    error.set("");
    const result = await authClient.signIn.emailOtp({
      email: otpEmail(),
      otp,
    });
    busy.set(false);
    if (result.error) {
      error.set(result.error.message ?? "Sign-in failed");
      return;
    }
    await waitForSession();
    navigate("/apps");
  };

  const showRecovery = () => {
    recovery.set(true);
    otpSent.set(false);
    error.set("");
  };

  const hideRecovery = () => {
    recovery.set(false);
    otpSent.set(false);
    error.set("");
  };

  if (recovery()) {
    return (
      <div class="flex flex-col gap-4">
        <h2 class="m-0 text-lg font-semibold">Lost passkey?</h2>
        <p class="m-0 text-sm opacity-80">
          We’ll email a one-time code to your account address. Passkeys stay the
          primary way in — this is only the spare key.
        </p>
        {otpSent() ? (
          <form onsubmit={verifyOtp} class="flex flex-col gap-3">
            <fieldset class="fieldset">
              <label class="label" for="otp-code">
                Code sent to {otpEmail()}
              </label>
              <input
                id="otp-code"
                name="otp"
                class="input w-full font-mono"
                placeholder="123456"
                autocomplete="one-time-code"
                maxlength={6}
                required
              />
            </fieldset>
            <button
              type="submit"
              class="btn btn-sm btn-primary"
              disabled={busy()}
            >
              Sign in
            </button>
          </form>
        ) : (
          <form onsubmit={sendOtp} class="flex flex-col gap-3">
            <fieldset class="fieldset">
              <label class="label" for="otp-email">
                Email
              </label>
              <input
                id="otp-email"
                name="email"
                type="email"
                class="input validator w-full"
                placeholder="Email"
                autocomplete="email"
                required
              />
              <p class="validator-hint hidden">Enter a valid email address</p>
            </fieldset>
            <button
              type="submit"
              class="btn btn-sm btn-primary"
              disabled={busy()}
            >
              Email me a code
            </button>
          </form>
        )}
        <button
          type="button"
          class="btn btn-sm btn-ghost w-fit"
          onclick={hideRecovery}
        >
          Back to passkeys
        </button>
        {error() ? <p class="text-error text-sm">{error()}</p> : null}
      </div>
    );
  }

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
          {invite()?.requiresInvite ? (
            <fieldset class="fieldset">
              <label class="label" for="register-invite">
                Invitation code
              </label>
              <input
                id="register-invite"
                name="invite"
                class="input w-full font-mono"
                placeholder="XXXX-XXXX-XXXX"
                autocomplete="off"
                spellcheck={false}
                required
              />
              <p class="label">
                This instance is invite-only. Ask a member for a code.
              </p>
            </fieldset>
          ) : null}
          <button
            type="submit"
            class="btn btn-sm btn-primary"
            disabled={busy()}
          >
            Create passkey
          </button>
        </form>
      ) : (
        <button
          type="button"
          class="btn btn-sm btn-primary"
          disabled={busy()}
          onclick={signIn}
        >
          Sign in with passkey
        </button>
      )}

      {error() ? <p class="text-error text-sm">{error()}</p> : null}
      <button
        type="button"
        class="link link-hover w-fit text-sm opacity-70"
        onclick={showRecovery}
      >
        Lost passkey?
      </button>
    </div>
  );
};
