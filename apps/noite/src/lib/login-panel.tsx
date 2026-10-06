import { navigate } from "@ilha/router";
import { atom, watch } from "ilha";

import { authClient } from "./auth-client";
import { signupPolicy } from "./resources";
import { fetchSession, invalidateSession } from "./session";
import { sleep } from "./sleep";

const registrationContext = (email: string, name: string, invite: string) =>
  JSON.stringify({ email, invite, name });

/** Heading + one line under it, per form state. */
const INTRO = {
  firstRun: {
    body: "You're the first one here, so this account becomes the admin.",
    title: "Set up Noite",
  },
  register: {
    body: "No password needed: you'll sign in with a passkey, using your fingerprint, face or device PIN.",
    title: "Create your account",
  },
  signin: {
    body: "Sign in with the passkey saved on this device.",
    title: "Welcome back",
  },
};

/** Page-load/passkey UX: the auth cookie may not be readable immediately,
 * so poll briefly. Then drop the anonymous caches the persistent layout
 * filled while /login was showing, so the dashboard loads as this user. */
const waitForSession = async (): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
    const session = await fetchSession();
    if (session.data?.user) {
      break;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
    await sleep(50);
  }
  invalidateSession();
};

/** Passkey register / sign-in. Navigates to `/apps` on success (SPA —
 * the session cookie is verified readable before leaving, so the gate
 * revalidates instantly with no document reload). Email OTP stays
 * behind "Lost passkey?" — recovery for passkey-less devices, not primary. */
export const LoginPanel = () => {
  const busy = atom(false);
  const error = atom("");
  // null = not chosen yet: a fresh instance opens on account creation,
  // everyone else on sign-in (returning users are the common case).
  const picked = atom<"register" | "signin" | null>(null);
  const recovery = atom(false);
  const otpSent = atom(false);
  const otpEmail = atom("");
  const policy = signupPolicy();
  const invite = () => policy.data();
  const mode = (): "register" | "signin" =>
    picked() ?? (invite()?.firstRun ? "register" : "signin");

  watch.once(async () => {
    const { data } = await fetchSession();
    if (data?.user) {
      navigate("/apps");
    }
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
    // A recovery sign-in exists because the passkey is gone: land on the
    // account page, where a new one can be added straight away.
    navigate("/account");
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
      <div class="flex flex-col gap-6">
        <div class="flex flex-col gap-2">
          <h1 class="m-0 text-2xl font-semibold tracking-tight">
            Lost your passkey?
          </h1>
          <p class="m-0 text-sm leading-relaxed opacity-70">
            We'll email a one-time code to your account address. Once you're in,
            add a new passkey from your Account page.
          </p>
        </div>
        {otpSent() ? (
          <form onsubmit={verifyOtp} class="flex flex-col gap-4">
            <fieldset class="fieldset p-0">
              <label class="label" for="otp-code">
                Code sent to {otpEmail()}
              </label>
              <input
                id="otp-code"
                name="otp"
                class="input w-full font-mono tracking-widest"
                placeholder="123456"
                autocomplete="one-time-code"
                maxlength={6}
                required
              />
            </fieldset>
            <button
              type="submit"
              class="btn btn-neutral w-full"
              disabled={busy()}
            >
              Sign in
            </button>
          </form>
        ) : (
          <form onsubmit={sendOtp} class="flex flex-col gap-4">
            <fieldset class="fieldset p-0">
              <label class="label" for="otp-email">
                Email
              </label>
              <input
                id="otp-email"
                name="email"
                type="email"
                class="input validator w-full"
                placeholder="you@example.com"
                autocomplete="email"
                required
              />
              <p class="validator-hint hidden">Enter a valid email address</p>
            </fieldset>
            <button
              type="submit"
              class="btn btn-neutral w-full"
              disabled={busy()}
            >
              Email me a code
            </button>
          </form>
        )}
        {error() ? <p class="text-error m-0 text-sm">{error()}</p> : null}
        <button
          type="button"
          class="link link-hover w-fit text-sm opacity-70"
          onclick={hideRecovery}
        >
          ← Back to sign in
        </button>
      </div>
    );
  }

  let intro = INTRO.register;
  if (mode() === "signin") {
    intro = INTRO.signin;
  } else if (invite()?.firstRun) {
    intro = INTRO.firstRun;
  }
  return (
    <div class="flex flex-col gap-6">
      <div class="flex flex-col gap-2">
        <h1 class="m-0 text-2xl font-semibold tracking-tight">{intro.title}</h1>
        <p class="m-0 text-sm leading-relaxed opacity-70">{intro.body}</p>
      </div>

      <div class="tabs tabs-box w-full" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode() === "signin" ? "true" : "false"}
          class={`tab flex-1 ${mode() === "signin" ? "tab-active" : ""}`}
          onclick={() => {
            picked.set("signin");
            error.set("");
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode() === "register" ? "true" : "false"}
          class={`tab flex-1 ${mode() === "register" ? "tab-active" : ""}`}
          onclick={() => {
            picked.set("register");
            error.set("");
          }}
        >
          Create account
        </button>
      </div>

      {mode() === "register" ? (
        <form onsubmit={register} class="flex flex-col gap-4">
          <fieldset class="fieldset p-0">
            <label class="label" for="register-name">
              Name
            </label>
            <input
              id="register-name"
              name="name"
              class="input w-full"
              placeholder="John Doe"
              autocomplete="name"
              required
            />
          </fieldset>
          <fieldset class="fieldset p-0">
            <label class="label" for="register-email">
              Email
            </label>
            <input
              id="register-email"
              name="email"
              type="email"
              class="input validator w-full"
              placeholder="you@example.com"
              autocomplete="username webauthn"
              required
            />
            <p class="validator-hint hidden">Enter a valid email address</p>
          </fieldset>
          {invite()?.requiresInvite ? (
            <fieldset class="fieldset p-0">
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
              <p class="label whitespace-normal">
                This instance is invite-only. Any member can share a code from
                their Account page.
              </p>
            </fieldset>
          ) : null}
          <button
            type="submit"
            class="btn btn-neutral w-full"
            disabled={busy()}
          >
            Create passkey
          </button>
        </form>
      ) : (
        <div class="flex flex-col gap-4">
          <button
            type="button"
            class="btn btn-neutral w-full"
            disabled={busy()}
            onclick={signIn}
          >
            Sign in with passkey
          </button>
          <button
            type="button"
            class="link link-hover w-fit self-center text-sm opacity-70"
            onclick={showRecovery}
          >
            Lost passkey?
          </button>
        </div>
      )}

      {error() ? <p class="text-error m-0 text-sm">{error()}</p> : null}
    </div>
  );
};
