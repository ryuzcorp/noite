/* eslint-disable max-classes-per-file -- tagged Fail types for auth */
/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import { apiKey } from "@better-auth/api-key";
import { kyselyAdapter } from "@better-auth/kysely-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OxideRequest } from "oxidejs";

import { ensureDbPromise, getAuthDb, missingDb, resolveEnv } from "./db";
import {
  checkInvite,
  consumeInvite,
  INVITES_PER_USER,
  mintInvites,
  signupPolicy,
} from "./invites.server";
import type { InviteProblem } from "./invites.server";

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class MissingAuthSecretError extends Schema.TaggedError<MissingAuthSecretError>()(
  "MissingAuthSecretError",
  { message: Schema.String }
) {}

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class UnauthorizedError extends Schema.TaggedError<UnauthorizedError>()(
  "UnauthorizedError",
  { message: Schema.String }
) {}

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
export class ActionError extends Schema.TaggedError<ActionError>()(
  "ActionError",
  { message: Schema.String }
) {}

export const failAction = (message: string): never => {
  throw new ActionError({ message });
};

/** Map an unknown catch value into a mapped ActionError (client-visible).
 * Use in action catch blocks instead of repeating the instanceof ternary. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site values are unknown by construction; this helper narrows to message
export const failUnknown = (error: unknown): never => {
  const message = error instanceof Error ? error.message : String(error);
  throw new ActionError({ message });
};

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
class InvalidRegistrationContextError extends Schema.TaggedError<InvalidRegistrationContextError>()(
  "InvalidRegistrationContextError",
  { message: Schema.String }
) {}

const RegistrationContext = Schema.Struct({
  email: Schema.String,
  invite: Schema.optional(Schema.String),
  name: Schema.String,
});

const parseRegistration = (context: string | null | undefined) =>
  Effect.gen(function* () {
    if (!context) {
      return yield* Effect.fail(
        new InvalidRegistrationContextError({
          message: "Registration context is required",
        })
      );
    }
    const raw = yield* Effect.try({
      catch: () =>
        new InvalidRegistrationContextError({
          message: "Registration context must be JSON",
        }),
      try: () => {
        try {
          return JSON.parse(context);
        } catch {
          throw new InvalidRegistrationContextError({
            message: "Registration context must be JSON",
          });
        }
      },
    });
    const decoded = yield* Schema.decodeUnknownEffect(RegistrationContext)(
      raw
    ).pipe(
      Effect.mapError(
        () =>
          new InvalidRegistrationContextError({
            message: "Registration context needs email and name strings",
          })
      )
    );
    const email = decoded.email.trim().toLowerCase();
    const name = decoded.name.trim();
    if (!(email && name)) {
      return yield* Effect.fail(
        new InvalidRegistrationContextError({
          message: "Email and name must be non-empty",
        })
      );
    }
    return { email, invite: decoded.invite?.trim() || undefined, name };
  });

/** User-facing reason a code was refused. The panel shows this verbatim. */
const inviteProblemMessage = (problem: InviteProblem): string => {
  switch (problem) {
    case "missing": {
      return "This instance is invite-only. Enter an invitation code.";
    }
    case "unknown": {
      return "That invitation code is not valid.";
    }
    case "revoked": {
      return "That invitation code was revoked. Ask for a new one.";
    }
    default: {
      return "That invitation code has already been used. Ask for a new one.";
    }
  }
};

const requireRegistration = (context: string | null | undefined) => {
  try {
    return Effect.runSync(parseRegistration(context));
  } catch (error) {
    if (error instanceof InvalidRegistrationContextError) {
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_REGISTRATION_CONTEXT",
        message: error.message,
      });
    }
    throw error;
  }
};

/** Deliver a sign-in OTP: POST to the configured webhook (Workers have no
 * SMTP sockets), dev-console fallback on localhost, loud refusal otherwise
 * (a silent no-op would lock every passkey-less user out with no trace). */
const sendSignInOTP = async (
  email: string,
  otp: string,
  env: KitEnv
): Promise<void> => {
  const webhook = env.NOITE_EMAIL_WEBHOOK_URL?.trim();
  if (webhook) {
    // Operator-configured URL (same trust as the SMTP URL it replaces),
    // but still constrained to http(s) before use as a fetch target.
    try {
      const { protocol } = new URL(webhook);
      if (protocol !== "http:" && protocol !== "https:") {
        throw new Error("NOITE_EMAIL_WEBHOOK_URL must be http(s)");
      }
    } catch (error) {
      throw error instanceof Error
        ? error
        : new Error("NOITE_EMAIL_WEBHOOK_URL is invalid");
    }
    // pi-lens-ignore: ts-ssrf -- operator-configured, scheme-validated URL (same trust as the SMTP URL it replaces); never user input.
    const response = await fetch(webhook, {
      body: JSON.stringify({
        email,
        from: env.NOITE_SMTP_FROM ?? "Noite <no-reply@localhost>",
        otp,
        type: "sign-in",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`OTP webhook failed with status ${response.status}`);
    }
    return;
  }
  if ((env.BASE_DOMAIN ?? "localhost") === "localhost") {
    // oxlint-disable-next-line no-console-except-error -- dev-only OTP delivery channel; prod uses the webhook or refuses loudly below.
    console.log(`[noite:otp] sign-in code for ${email}: ${otp}`);
    return;
  }
  throw new Error("Email delivery is not configured (NOITE_EMAIL_WEBHOOK_URL)");
};

/** Hostname for the passkey RP ID. Bad config must fail loud (a silent
 * fallback would misbind passkeys), surfaced as the mapped 500. */
const rpHostname = (baseURL: string): string => {
  try {
    return new URL(baseURL).hostname;
  } catch {
    throw new MissingAuthSecretError({
      message: "noite: BETTER_AUTH_URL is invalid",
    });
  }
};

/** Better-auth's per-client budget (`NOITE_AUTH_RATE_LIMIT`), sized for a UI
 * that asks for the session on every navigation. */
const publicAuthRpm = (): number => {
  const raw = resolveEnv().NOITE_AUTH_RATE_LIMIT;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 600;
};

export const createAuth = (env: KitEnv, baseURL: string) =>
  betterAuth({
    advanced: {
      database: {
        validateSchema: false,
      },
      // Resolve the client address from the proxy's header first. Without this
      // better-auth warns that it cannot determine a client IP and falls back
      // to ONE shared bucket per path for every caller — which turns its rate
      // limit into a fleet-wide outage under normal traffic.
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "cf-connecting-ip"],
      },
    },
    baseURL,
    database: kyselyAdapter(getAuthDb()),
    plugins: [
      // God-mode impersonates any account (including fellow admins) — the
      // impersonator is already an admin, so this grants no new power.
      admin({ allowImpersonatingAdmins: true, defaultRole: "user" }),
      // Lost-passkey recovery: email OTP is deliberately secondary — the
      // login UI keeps passkeys primary and reveals this behind
      // "Lost passkey?". Sign-in only (no auto-provisioning strangers).
      emailOTP({
        allowedAttempts: 5,
        expiresIn: 600,
        otpLength: 6,
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") {
            return;
          }
          await sendSignInOTP(email, otp, env);
        },
      }),
      apiKey({
        defaultPrefix: "noite_",
        enableMetadata: false,
        // Machine scopes: `apps.manage` (git push and other app-management
        // API calls) and `events.push` (event ingest). Keys created without
        // explicit permissions inherit both, preserving current behavior;
        // legacy keys get the same via the ensureDb backfill.
        permissions: {
          defaultPermissions: { apps: ["manage"], events: ["push"] },
        },
        rateLimit: {
          enabled: false,
          maxRequests: 10_000,
          timeWindow: 1000 * 60 * 60 * 24,
        },
        requireName: true,
      }),
      passkey({
        registration: {
          afterVerification: async ({ context, ctx }) => {
            const parsed = requireRegistration(context);
            const existing = await ctx.context.internalAdapter.findUserByEmail(
              parsed.email
            );
            if (existing?.user) {
              throw APIError.from("BAD_REQUEST", {
                code: "USER_ALREADY_EXISTS",
                message:
                  "An account with this email already exists. Sign in instead.",
              });
            }
            // Invite-only: the first account bootstraps the instance (it owns
            // it, so it also becomes the admin), every later one needs a code.
            const policy = await signupPolicy();
            if (!policy.firstRun) {
              const problem = await checkInvite(parsed.invite);
              if (problem) {
                throw APIError.from("FORBIDDEN", {
                  code: "INVITE_REQUIRED",
                  message: inviteProblemMessage(problem),
                });
              }
            }
            const user = await ctx.context.internalAdapter.createUser(
              {
                email: parsed.email,
                emailVerified: true,
                name: parsed.name,
              },
              { method: "passkey" }
            );
            if (!policy.firstRun && parsed.invite) {
              const claimed = await consumeInvite(parsed.invite, user.id);
              if (!claimed) {
                // Lost the race for this code: drop the half-created account
                // instead of leaving one that no invite covers. Best effort —
                // the registration fails either way.
                try {
                  await ctx.context.internalAdapter.deleteUser(user.id);
                } catch {
                  // Nothing to do: the account is unusable without a passkey.
                }
                throw APIError.from("FORBIDDEN", {
                  code: "INVITE_REQUIRED",
                  message: inviteProblemMessage("used"),
                });
              }
            }
            if (policy.firstRun) {
              // The bootstrap account owns the instance; the role persists even
              // when NOITE_ADMIN_EMAIL is unset.
              await ctx.context.internalAdapter.updateUser(user.id, {
                role: "admin",
              });
            }
            // Every account can invite its own share.
            await mintInvites(user.id, INVITES_PER_USER);
            return { userId: user.id };
          },
          requireSession: false,
          resolveUser: ({ context }) => {
            const parsed = requireRegistration(context);
            return {
              displayName: parsed.name,
              id: crypto.randomUUID(),
              name: parsed.email,
            };
          },
        },
        rpID: rpHostname(baseURL),
        rpName: "Noite",
      }),
    ],
    // Built-in auth rate limiting: every /api/auth call is counted per client
    // IP, so passkey sign-in and the invite gate cannot be brute-forced. The
    // budget has to clear a real UI's session polling (each navigation asks for
    // the session, and the login page polls while the cookie settles) — 120/min
    // tripped during an e2e run, which then blocked every later action. The
    // platform limiter in http/routes.ts is the coarser backstop.
    rateLimit: {
      enabled: true,
      max: publicAuthRpm(),
      window: 60,
    },
    secret: env.BETTER_AUTH_SECRET,
  });

/** Port of the retired joint image's boot gate: never serve auth with
 * repo-shipped dev credentials on a real domain. The worker entry is
 * virtual (no boot hook), so callers run this on first auth construction —
 * still fail-loud before any session exists. Returns the refusal message,
 * or null when the credentials may serve. */
const defaultSecretRefusal = (env: KitEnv, baseURL: string): string | null => {
  let local = false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    local =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.endsWith(".localhost") ||
      // mDNS/LAN dev domains (e.g. https://noite.local via the README LAN
      // setup) are non-routable by definition — never a prod domain.
      host.endsWith(".local");
  } catch {
    local = false;
  }
  if (local) {
    return null;
  }
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (!secret || secret.startsWith("dev-")) {
    return `noite: refusing default BETTER_AUTH_SECRET on ${baseURL}`;
  }
  return null;
};

export const authFromEnv = (env: KitEnv, origin: string) => {
  if (!env.BETTER_AUTH_SECRET) {
    throw new MissingAuthSecretError({
      message: "noite: BETTER_AUTH_SECRET is missing",
    });
  }
  const baseURL = env.BETTER_AUTH_URL ?? origin;
  const refusal = defaultSecretRefusal(env, baseURL);
  if (refusal) {
    throw new MissingAuthSecretError({ message: refusal });
  }
  return createAuth(
    {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    },
    baseURL
  );
};

export const authFromEnvEffect = (env: KitEnv, origin: string) =>
  Effect.gen(function* () {
    if (!env.BETTER_AUTH_SECRET) {
      return yield* Effect.fail(
        new MissingAuthSecretError({
          message: "noite: BETTER_AUTH_SECRET is missing",
        })
      );
    }
    const baseURL = env.BETTER_AUTH_URL ?? origin;
    const refusal = defaultSecretRefusal(env, baseURL);
    if (refusal) {
      return yield* Effect.fail(
        new MissingAuthSecretError({ message: refusal })
      );
    }
    return createAuth(
      {
        BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      },
      baseURL
    );
  });

export interface SessionUser {
  email: string;
  id: string;
  name: string;
}

/** Instance-admin check by user id: `admin` role, or the env-anchored
 * bootstrap address. Used to let admins manage every app, not just ones
 * they collaborate on. */
/** Instance-admin anchor from the environment (`NOITE_ADMIN_EMAIL`,
 * lowercased). One definition for the access gate and the admin panel. */
export const resolveAdminEmail = (): string | null => {
  const raw = resolveEnv().NOITE_ADMIN_EMAIL;
  if (raw === undefined) {
    return null;
  }
  const email = raw.trim().toLowerCase();
  return email || null;
};

export const requireUser = Effect.gen(function* () {
  const request = yield* OxideRequest;
  const env = resolveEnv();
  yield* Effect.promise(() => ensureDbPromise());
  if (!env.BETTER_AUTH_SECRET) {
    return yield* Effect.fail(missingDb());
  }
  // Malformed request URL must 401 like a missing session, never defect.
  let origin: string;
  try {
    ({ origin } = new URL(request.url));
  } catch {
    return yield* Effect.fail(
      new UnauthorizedError({ message: "Sign in required" })
    );
  }
  const auth = yield* authFromEnvEffect(env, origin);
  const session = yield* Effect.tryPromise({
    catch: () => new UnauthorizedError({ message: "Sign in required" }),
    try: () => auth.api.getSession({ headers: request.headers }),
  });
  const user = session?.user;
  if (!user) {
    return yield* Effect.fail(
      new UnauthorizedError({ message: "Sign in required" })
    );
  }
  return { email: user.email, id: user.id, name: user.name };
});
