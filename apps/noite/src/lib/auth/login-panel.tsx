//! The login / registration / recovery panel, as an `@ilha/model` island.
//!
//! States (`Panel`) and the transitions (all of them live in `update`):
//!
//! ```mermaid
//! stateDiagram-v2
//!   [*] --> Policy: SSR paints the neutral panel, controls disabled
//!   Policy --> Ready: PolicyLoaded(firstRun, requiresInvite)
//!   Policy --> Policy: PolicyFailed(message), Retry re-asks
//!   Ready --> Ready: Pick(register | signin)
//!   Ready --> Busy: Register / SignIn (busy flag)
//!   Busy --> Ready: Failed(message)
//!   Busy --> Recovery: OtpSent(email)
//!   Recovery --> Busy: VerifyOtp
//!   Busy --> Done: AuthOk(landing)
//!   Done --> [*]: navigate
//! ```
//!
//! Two rules are fixed here, in the model:
//! - **no tab flip under a click**: `Policy` is a real state, not a default —
//!   the panel shows a neutral heading and disabled controls until the signup
//!   policy lands, so a first-run instance never swaps *Sign in* for *Create
//!   account* mid-click (the old `mode()` derived from an async resource);
//! - **sign-in verifies the session like registration does**: every auth round
//!   trip polls for a readable session cookie and answers `Failed` when the
//!   client reports success but there is no session, instead of navigating
//!   into an `/apps` → `/login` loop.
import { defineApp } from "@ilha/model";
import type { Dispatch } from "@ilha/model";
import { useRouter } from "@ilha/void";
import { Data } from "effect";
import * as Effect from "effect/Effect";
import { watch } from "ilha";

import { authClient } from "../auth-client";
import { sameOriginPath } from "../env-auth";
import { errorMessage } from "../errors";
import { resourceValue } from "../resource";
import { signupPolicy } from "../resources";
import { searchParam } from "../search-param";
import { sleep } from "../sleep";
import { fetchSession, invalidateSession } from "./session";

export type Mode = "register" | "signin";

type Panel = Data.TaggedEnum<{
  /** Navigating to the signed-in app after a successful auth. */
  Done: { readonly landing: string };
  /** The signup policy is still in flight: neutral, controls disabled. */
  Policy: Record<never, never>;
  /** Lost-passkey flow: ask for the address, then for the code. */
  Recovery: { readonly email: string; readonly step: "code" | "email" };
  /** The policy landed; both tabs work. */
  Ready: {
    readonly firstRun: boolean;
    readonly mode: Mode;
    readonly requiresInvite: boolean;
  };
}>;

const Panels = Data.taggedEnum<Panel>();

type Message = Data.TaggedEnum<{
  /** The round trip finished and the session cookie reads back. */
  AuthOk: { readonly landing: string };
  Failed: { readonly message: string };
  HideRecovery: Record<never, never>;
  /** The first client mount: the controls may act now. */
  Mounted: Record<never, never>;
  /** No session on load: stay on the form (no message needed). */
  NoSession: Record<never, never>;
  /** The OTP went out; ask for the code. */
  OtpSent: { readonly email: string };
  Pick: { readonly mode: Mode };
  PolicyFailed: { readonly message: string };
  PolicyLoaded: {
    readonly firstRun: boolean;
    readonly requiresInvite: boolean;
  };
  Register: {
    readonly email: string;
    readonly invite: string;
    readonly name: string;
  };
  Retry: Record<never, never>;
  SendOtp: { readonly email: string };
  ShowRecovery: Record<never, never>;
  SignIn: Record<never, never>;
  VerifyOtp: { readonly otp: string };
}>;

const Msg = Data.taggedEnum<Message>();

interface Model {
  readonly busy: boolean;
  readonly error: string;
  /** False during SSR and the first paint: the form has no handlers yet, so
   * its controls stay disabled rather than swallowing a click. */
  readonly mounted: boolean;
  readonly panel: Panel;
}

const registrationContext = (email: string, name: string, invite: string) =>
  JSON.stringify({ email, invite, name });

interface Intro {
  readonly body: string;
  readonly title: string;
}

/** Heading + one line under it, per form state. */
const INTRO: Record<"firstRun" | "loading" | "register" | "signin", Intro> = {
  firstRun: {
    body: "You're the first one here, so this account becomes the admin.",
    title: "Set up Noite",
  },
  loading: {
    body: "Checking how this instance accepts new accounts…",
    title: "Noite",
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

const introOf = (panel: Panel): Intro => {
  if (panel._tag === "Ready") {
    if (panel.firstRun) {
      return INTRO.firstRun;
    }

    return panel.mode === "register" ? INTRO.register : INTRO.signin;
  }

  return INTRO.loading;
};

/** Poll briefly for the auth cookie: the passkey flow can mint the session a
 * moment after the call returns. */
const waitForSession = async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential cookie-readiness poll; Promise.all would defeat the early-exit
    const session = await fetchSession();

    if (session.data?.user) {
      // Drop the anonymous caches the persistent layout filled while /login
      // was showing, so the dashboard loads as this user.
      invalidateSession();

      return session.data;
    }

    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential poll backoff
    await sleep(50);
  }

  return null;
};

/** One auth round trip: run `call`, then require a readable session. Both the
 * register and the sign-in paths go through this, so "the client said ok but
 * there is no session" can only ever become `Failed`. The promise never
 * rejects: every failure is already a message. */
const authRoundTrip = (
  call: () => Promise<{ message?: string } | null>,
  landing: string
): Effect.Effect<Message, never, never> =>
  Effect.promise(async (): Promise<Message> => {
    try {
      const failure = await call();

      if (failure) {
        return Msg.Failed({
          message: failure.message ?? "Authentication failed",
        });
      }

      const session = await waitForSession();

      return session === null
        ? Msg.Failed({
            message:
              "Signed in, but the session could not be read back. Reload and try again.",
          })
        : Msg.AuthOk({ landing });
    } catch (error) {
      return Msg.Failed({ message: errorMessage(error) });
    }
  });

/** Re-read the signup policy (init, and the Retry on a failed load). */
const policyCmd: Effect.Effect<Message, never, never> = Effect.promise(
  async (): Promise<Message> => {
    try {
      const policy = signupPolicy();

      await policy.refetch();

      const value = resourceValue(policy.state());

      return value === undefined
        ? Msg.PolicyFailed({ message: "Could not read the signup policy" })
        : Msg.PolicyLoaded({
            firstRun: value.firstRun,
            requiresInvite: value.requiresInvite,
          });
    } catch (error) {
      return Msg.PolicyFailed({ message: errorMessage(error) });
    }
  }
);

/** A session already under way (a stale tab, a passkey ceremony finished in
 * another tab) goes straight to the app; no session stays on the form. */
const initialSession: Effect.Effect<Message, never, never> = Effect.promise(
  async (): Promise<Message> => {
    try {
      const result = await authClient.getSession();

      return result.data?.user
        ? Msg.AuthOk({ landing: "/apps" })
        : Msg.NoSession();
    } catch {
      return Msg.NoSession();
    }
  }
);

/** Every command here catches its own failures and answers a message, so the
 * error channel is empty. The annotation states that invariant once instead of
 * leaving it to inference. */
const cmd = (
  effect: Effect.Effect<Message, unknown, never>
): Effect.Effect<Message, never, never> =>
  // SAFETY: each caller turns its expected failures into a message inside the
  // effect (see `authRoundTrip` / the policy and OTP handlers), so nothing can
  // reach the error channel at runtime.
  effect as Effect.Effect<Message, never, never>;

const isReady = (panel: Panel): panel is Extract<Panel, { _tag: "Ready" }> =>
  panel._tag === "Ready";

/** The island: the model, its messages and the one `update`. */

/** A passkey-driven sign-in lands where the `return` param asked for; the OTP
 * recovery flow keeps its own landing. */
const Navigate = ({ to }: { to: string }) => {
  const router = useRouter();
  const returnTo = searchParam("return", { default: "" });

  const landing = to === "/apps" ? (sameOriginPath(returnTo()) ?? "/apps") : to;

  watch.once(() => {
    router.visit(landing);
  });

  return <p class="m-0 text-sm opacity-70">Signing you in…</p>;
};

const FormError = ({ message }: { message: string }) =>
  message ? <p class="text-error m-0 text-sm">{message}</p> : null;

const formData = (event: SubmitEvent): FormData | undefined =>
  event.currentTarget instanceof HTMLFormElement
    ? new FormData(event.currentTarget)
    : undefined;

const text = (data: FormData, field: string): string =>
  String(data.get(field) ?? "").trim();

const RecoveryForm = ({
  dispatch,
  model,
}: {
  dispatch: Dispatch<Message>;
  model: Model;
}) => {
  const step = model.panel._tag === "Recovery" ? model.panel.step : "email";
  const email = model.panel._tag === "Recovery" ? model.panel.email : "";

  return (
    <>
      <div class="flex flex-col gap-2">
        <h1 class="m-0 text-2xl font-semibold tracking-tight">
          Lost your passkey?
        </h1>
        <p class="m-0 text-sm leading-relaxed opacity-70">
          We'll email a one-time code to your account address. Once you're in,
          add a new passkey from your Account page.
        </p>
      </div>
      {step === "code" ? (
        <form
          class="flex flex-col gap-4"
          onsubmit={(event) => {
            event.preventDefault();

            const data = formData(event);

            if (!data) {
              return;
            }

            const otp = text(data, "otp");

            if (!otp) {
              dispatch(Msg.Failed({ message: "Code is required" }));

              return;
            }

            dispatch(Msg.VerifyOtp({ otp }));
          }}
        >
          <fieldset class="fieldset p-0">
            <label class="label" for="otp-code">
              Code sent to {email}
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
            disabled={model.busy}
          >
            Sign in
          </button>
        </form>
      ) : (
        <form
          class="flex flex-col gap-4"
          onsubmit={(event) => {
            event.preventDefault();

            const data = formData(event);

            if (!data) {
              return;
            }

            const address = text(data, "email");

            if (!address) {
              dispatch(Msg.Failed({ message: "Email is required" }));

              return;
            }

            dispatch(Msg.SendOtp({ email: address }));
          }}
        >
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
            disabled={model.busy}
          >
            Email me a code
          </button>
        </form>
      )}
      <FormError message={model.error} />
      <button
        type="button"
        class="link link-hover w-fit text-sm opacity-70"
        onclick={() => {
          dispatch(Msg.HideRecovery());
        }}
      >
        ← Back to sign in
      </button>
    </>
  );
};

/** The sign-in / register panel: tabs, heading and the active form. */
const RegisterForm = ({
  dispatch,
  model,
}: {
  dispatch: Dispatch<Message>;
  model: Model;
}) => {
  const ready = model.panel._tag === "Ready";
  const requiresInvite = ready && model.panel.requiresInvite;

  return (
    <form
      class="flex flex-col gap-4"
      onsubmit={(event) => {
        event.preventDefault();

        const data = formData(event);

        if (!data) {
          return;
        }

        const email = text(data, "email");
        const name = text(data, "name");
        const invite = text(data, "invite");

        if (!(email && name)) {
          dispatch(Msg.Failed({ message: "Name and email are required" }));

          return;
        }

        if (requiresInvite && !invite) {
          dispatch(
            Msg.Failed({
              message: "An invitation code is required on this instance",
            })
          );

          return;
        }

        dispatch(Msg.Register({ email, invite, name }));
      }}
    >
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
      {requiresInvite ? (
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
            This instance is invite-only. Any member can share a code from their
            Account page.
          </p>
        </fieldset>
      ) : null}
      <button
        type="submit"
        class="btn btn-neutral w-full"
        disabled={model.busy}
      >
        Create passkey
      </button>
    </form>
  );
};

const SignInForm = ({
  busy,
  dispatch,
}: {
  busy: boolean;
  dispatch: Dispatch<Message>;
}) => (
  <div class="flex flex-col gap-4">
    <button
      type="button"
      class="btn btn-neutral w-full"
      disabled={busy}
      onclick={() => {
        dispatch(Msg.SignIn());
      }}
    >
      Sign in with passkey
    </button>
    <button
      type="button"
      class="link link-hover w-fit self-center text-sm opacity-70"
      onclick={() => {
        dispatch(Msg.ShowRecovery());
      }}
    >
      Lost passkey?
    </button>
  </div>
);

const CredentialsForm = ({
  dispatch,
  model,
}: {
  dispatch: Dispatch<Message>;
  model: Model;
}) => {
  const intro = introOf(model.panel);
  const ready = model.panel._tag === "Ready";
  const mode: Mode = ready ? model.panel.mode : "signin";

  return (
    <>
      <div class="flex flex-col gap-2">
        <h1 class="m-0 text-2xl font-semibold tracking-tight">{intro.title}</h1>
        <p class="m-0 text-sm leading-relaxed opacity-70">{intro.body}</p>
      </div>
      {ready ? (
        <div class="tabs tabs-box w-full" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "signin" ? "true" : "false"}
            class={`tab flex-1 ${mode === "signin" ? "tab-active" : ""}`}
            onclick={() => {
              dispatch(Msg.Pick({ mode: "signin" }));
            }}
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "register" ? "true" : "false"}
            class={`tab flex-1 ${mode === "register" ? "tab-active" : ""}`}
            onclick={() => {
              dispatch(Msg.Pick({ mode: "register" }));
            }}
          >
            Create account
          </button>
        </div>
      ) : null}
      {!ready || mode === "register" ? (
        <RegisterForm dispatch={dispatch} model={model} />
      ) : (
        <SignInForm dispatch={dispatch} busy={model.busy} />
      )}
      <FormError message={model.error} />
      {ready ? null : (
        <button
          type="button"
          class="link link-hover w-fit text-sm opacity-70"
          disabled={model.busy}
          onclick={() => {
            dispatch(Msg.Retry());
          }}
        >
          Try again
        </button>
      )}
    </>
  );
};

/** Back to the sign-in tab from anywhere (recovery cancels to here). */
const baseSignin = (panel: Panel): Panel =>
  isReady(panel)
    ? { ...panel, mode: "signin" }
    : Panels.Ready({ firstRun: false, mode: "signin", requiresInvite: true });

export const LoginPanelApp = defineApp({
  init: () => ({
    cmd: [cmd(Effect.succeed(Msg.Mounted())), policyCmd, initialSession],
    model: {
      busy: false,
      error: "",
      mounted: false,
      panel: Panels.Policy(),
    },
  }),
  name: "LoginPanel",
  update: (model: Model, message: Message) => {
    switch (message._tag) {
      case "Mounted": {
        return { model: { ...model, mounted: true } };
      }

      case "NoSession": {
        return { model };
      }

      case "PolicyLoaded": {
        return {
          model: {
            ...model,
            panel: Panels.Ready({
              firstRun: message.firstRun,
              mode: message.firstRun ? "register" : "signin",
              requiresInvite: message.requiresInvite,
            }),
          },
        };
      }

      case "PolicyFailed": {
        return {
          model: { ...model, busy: false, error: message.message },
        };
      }

      case "Retry": {
        return {
          cmd: policyCmd,
          model: { ...model, busy: true, error: "", panel: Panels.Policy() },
        };
      }

      case "Pick": {
        return isReady(model.panel)
          ? {
              model: {
                ...model,
                error: "",
                panel: { ...model.panel, mode: message.mode },
              },
            }
          : { model };
      }

      case "ShowRecovery": {
        return {
          model: {
            ...model,
            error: "",
            panel: Panels.Recovery({ email: "", step: "email" }),
          },
        };
      }

      case "HideRecovery": {
        return {
          model: {
            ...model,
            busy: false,
            error: "",
            panel: baseSignin(model.panel),
          },
        };
      }

      case "OtpSent": {
        return {
          model: {
            ...model,
            busy: false,
            error: "",
            panel: Panels.Recovery({ email: message.email, step: "code" }),
          },
        };
      }

      case "AuthOk": {
        return {
          model: {
            ...model,
            busy: false,
            error: "",
            panel: Panels.Done({ landing: message.landing }),
          },
        };
      }

      case "Failed": {
        return { model: { ...model, busy: false, error: message.message } };
      }

      case "Register": {
        return {
          cmd: cmd(
            authRoundTrip(async () => {
              const result = await authClient.passkey.addPasskey({
                context: registrationContext(
                  message.email,
                  message.name,
                  message.invite
                ),
                createSession: true,
                name: "Primary",
              });

              return result.error ?? null;
            }, "/apps")
          ),
          model: { ...model, busy: true, error: "" },
        };
      }

      case "SignIn": {
        return {
          cmd: cmd(
            authRoundTrip(async () => {
              const result = await authClient.signIn.passkey();

              return result.error ?? null;
            }, "/apps")
          ),
          model: { ...model, busy: true, error: "" },
        };
      }

      case "SendOtp": {
        return {
          cmd: cmd(
            Effect.promise(async (): Promise<Message> => {
              try {
                const result = await authClient.emailOtp.sendVerificationOtp({
                  email: message.email,
                  type: "sign-in",
                });

                return result.error
                  ? Msg.Failed({
                      message: result.error.message ?? "Failed to send code",
                    })
                  : Msg.OtpSent({ email: message.email });
              } catch (error) {
                return Msg.Failed({ message: errorMessage(error) });
              }
            })
          ),
          model: { ...model, busy: true, error: "" },
        };
      }

      default: {
        // VerifyOtp
        const email = model.panel._tag === "Recovery" ? model.panel.email : "";

        return {
          cmd: cmd(
            authRoundTrip(async () => {
              const result = await authClient.signIn.emailOtp({
                email,
                otp: message.otp,
              });

              return result.error ?? null;
            }, "/account")
          ),
          model: { ...model, busy: true, error: "" },
        };
      }
    }
  },
  view: (model: Model, dispatch) => {
    if (model.panel._tag === "Done") {
      return <Navigate to={model.panel.landing} />;
    }

    return (
      <fieldset
        class="m-0 flex min-w-0 flex-col gap-6 border-0 p-0"
        disabled={!model.mounted}
      >
        {model.panel._tag === "Recovery" ? (
          <RecoveryForm model={model} dispatch={dispatch} />
        ) : (
          <CredentialsForm model={model} dispatch={dispatch} />
        )}
      </fieldset>
    );
  },
});

/** Mount this in a page (`<LoginPanel />`): `defineApp` components take no
 * props, and this panel needs none beyond `?return`, which it reads itself. */
export const LoginPanel = LoginPanelApp.component;
