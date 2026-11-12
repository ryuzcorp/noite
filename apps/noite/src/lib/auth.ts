/* eslint-disable max-classes-per-file -- tagged Fail types for auth */
/* eslint-disable func-names -- Effect.gen uses anonymous generators */
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { admin } from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { InstanceAuthority } from "./authority";
import { getAuthDb, resolveEnv } from "./db";
import { errorLogText, errorMessage } from "./errors";
import { isLocalhostDomain } from "./local-host";
import { fail } from "./server/api";
import { revokeApiKeysForUser } from "./server/api-keys.server";
import {
  checkInvite,
  claimBootstrapAdmin,
  consumeInvite,
  INVITES_PER_USER,
  mintInvites,
  signupPolicy,
} from "./server/invites.server";
import type { InviteProblem } from "./server/invites.server";

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

/** Map an unknown catch value into a client-visible `fail(message)`. The
 * action transport answers a plain throw with a 500 `Internal error`; this
 * keeps the real message the user needs. Use in action catch blocks. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- catch-site values are unknown by construction; this helper narrows to message
export const failUnknown = (error: unknown): never => fail(errorMessage(error));

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

/** The admin plugin's request bodies/results, decoded at the hook boundary. */
const AdminUpdateBody = Schema.Struct({
  data: Schema.Struct({ banned: Schema.optional(Schema.Boolean) }),
  userId: Schema.String,
});

const AdminUnbanResult = Schema.Struct({
  user: Schema.Struct({ id: Schema.String }),
});

const AdminUser = Schema.Struct({ id: Schema.String });

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

  if (isLocalhostDomain(env.BASE_DOMAIN ?? "localhost")) {
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
      // `withTrustedClientAddress` (lib/rate-limit.ts) collapses
      // X-Forwarded-For to the one trusted address before
      // the request reaches better-auth (a client controls the left-most
      // entries), so the first value read here is safe to key on.
      ipAddress: {
        ipAddressHeaders: ["x-forwarded-for", "cf-connecting-ip"],
      },
    },
    baseURL,
    database: getAuthDb(),
    // A non-API failure is rethrown instead of answered by the router, whose
    // own `console.error("# SERVER_ERROR:", error)` prints it raw. `handleAuth`
    // catches it, logs the cause chain and answers a generic 500; real API
    // errors still become their own responses.
    onAPIError: { throw: true },
    // better-auth's internal catches (the session lookup, key verification,
    // passkeys) log the failure themselves, before any of our boundaries. A
    // database failure there is drizzle's statement plus every bound value — a
    // session token among them — so every `Error` argument goes through the
    // cause-chain formatter. Levels are unchanged (the default threshold keeps
    // info/debug out).
    logger: {
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- better-auth hands the raw logged values; the formatter narrows them.
      log: (level, message, ...args) => {
        const text = [
          `[auth] ${level}: ${message}`,
          ...args.map((arg) =>
            arg instanceof Error ? errorLogText(arg) : String(arg)
          ),
        ];

        if (level === "error") {
          console.error(...text);
        } else if (level === "warn") {
          console.warn(...text);
        } else {
          console.log(...text);
        }
      },
    },
    // A ban revokes the account's machine credentials in the same flow as
    // the session deletion: the admin plugin's `banUser` (and a direct
    // `POST /api/auth/admin/ban-user`) both write `banned: true` through
    // `internalAdapter.updateUser`, so every ban path lands here. Deleting
    // the keys is deliberate — an unban must not silently revive a key.
    // Consumers still refuse a banned owner's key (lib/server/api-keys.server),
    // so a failed delete below is logged and left to that predicate; it must
    // never abort the update, or the plugin would skip `deleteUserSessions`
    // and leave a banned account with a live session.
    databaseHooks: {
      user: {
        update: {
          after: async (user) => {
            if (user.banned !== true) {
              return;
            }

            try {
              await revokeApiKeysForUser(user.id);
            } catch (error) {
              console.error(
                "[auth] ban key revocation failed",
                errorLogText(error)
              );
            }
          },
        },
      },
    },
    // The plugin's own HTTP endpoints are not covered by the app action's
    // checks. Key creation refuses a banned owner even if a session survived
    // the ban (the crash window), and an unban sweeps keys a create raced in
    // during the ban — revoked stays revoked. The sweep reads the *success
    // payload*, never the request: better-auth runs after hooks even when the
    // endpoint refused, so decoding the body would let any caller delete a
    // victim's keys with a failed unban request.
    hooks: {
      after: createAuthMiddleware(async (ctx) => {
        if (
          ctx.path !== "/admin/unban-user" &&
          ctx.path !== "/admin/update-user"
        ) {
          return;
        }

        if (isAPIError(ctx.context.returned)) {
          return;
        }

        // `/admin/update-user` doubles as an unban only when it says so.
        if (ctx.path === "/admin/update-user") {
          const update = Schema.decodeUnknownResult(AdminUpdateBody)(ctx.body);

          if (
            update._tag !== "Success" ||
            update.success.data.banned !== false
          ) {
            return;
          }
        }

        // `/admin/unban-user` answers `{user}`, `/admin/update-user` answers
        // the user object directly; decode the shape of the path that ran.
        const result =
          ctx.path === "/admin/unban-user"
            ? Schema.decodeUnknownResult(AdminUnbanResult)(ctx.context.returned)
            : Schema.decodeUnknownResult(AdminUser)(ctx.context.returned);

        if (result._tag !== "Success") {
          return;
        }

        const userId =
          "user" in result.success ? result.success.user.id : result.success.id;

        try {
          await revokeApiKeysForUser(userId);
        } catch (error) {
          console.error("[auth] unban key sweep failed", errorLogText(error));
        }
      }),
      before: createAuthMiddleware(async (ctx) => {
        // A key's scope and expiry are decided when it is minted. `update` is
        // reachable from the owner's own session, and with `enableMetadata`
        // it would let that session widen a key (or clear its expiry) after
        // the fact — so the mint-time fields are refused there. Revoking and
        // minting a new key is the supported path.
        if (ctx.path === "/api-key/update") {
          const body = Schema.decodeUnknownResult(
            Schema.Record(Schema.String, Schema.Json)
          )(ctx.body ?? {});

          if (
            body._tag === "Success" &&
            ("metadata" in body.success || "expiresIn" in body.success)
          ) {
            throw APIError.from("BAD_REQUEST", {
              code: "KEY_SCOPE_IS_MINT_TIME",
              message:
                "A key's scope and expiry are set when it is minted. Revoke the key and create a new one.",
            });
          }
        }

        if (ctx.path !== "/api-key/create") {
          return;
        }

        const read = await getSessionFromCtx(ctx);

        if (read?.user.banned !== true) {
          return;
        }

        throw APIError.from("FORBIDDEN", {
          code: "BANNED_USER",
          message: "This account is banned",
        });
      }),
    },
    plugins: [
      // The admin home impersonates any account (including fellow admins) — the
      // impersonator is already an admin, so this grants no new power.
      admin({ allowImpersonatingAdmins: true, defaultRole: "user" }),
      // Lost-passkey recovery: email OTP is deliberately secondary — the
      // login UI keeps passkeys primary and reveals this behind
      // "Lost passkey?". Sign-in only: `disableSignUp` is what stops a code
      // sent to an unknown address from creating an account, which would walk
      // around the invite gate that passkey registration enforces.
      emailOTP({
        allowedAttempts: 5,
        disableSignUp: true,
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
        // Scope, role ceiling and key label ride in `metadata` (the shape is
        // lib/key-principal's `KeyMetadata`). Without this the create action
        // cannot store them and every key would be account-wide.
        enableMetadata: true,
        // The shortest preset the account page offers is one hour; the
        // plugin's default floor is one day, which would refuse it.
        keyExpiration: { minExpiresIn: 0 },
        // Machine scopes: `apps.manage` (git push and other app-management
        // API calls) and `events.push` (event ingest). Keys created without
        // explicit permissions inherit both.
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
            // A signed-in account adding another passkey (the account page,
            // or right after an emailed-code recovery) provisions nothing:
            // there is no registration context and no user to create.
            const session = await getSessionFromCtx(ctx);

            if (session?.user?.id) {
              return { userId: session.user.id };
            }

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
            // `firstRun` is only a hint: two concurrent first registrations
            // both read an empty table, and the conditional claim below is
            // what decides which of them owns the instance.
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

            if (policy.firstRun) {
              // One account wins the bootstrap slot (the `role` cell is the
              // claim, no schema change); the loser is an ordinary account
              // that skipped the invite gate by racing the first one, so it
              // is dropped and refused instead of admitted.
              const claim = await claimBootstrapAdmin(user.id);

              if (claim._tag === "Lost") {
                try {
                  await ctx.context.internalAdapter.deleteUser(user.id);
                } catch {
                  // Nothing to do: the account is unusable without a passkey.
                }

                throw APIError.from("FORBIDDEN", {
                  code: "INVITE_REQUIRED",
                  message: inviteProblemMessage("missing"),
                });
              }
            } else if (parsed.invite) {
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
    // platform limiter in http/router.ts is the coarser backstop.
    rateLimit: {
      enabled: true,
      max: publicAuthRpm(),
      window: 60,
    },
    secret: env.BETTER_AUTH_SECRET,
    // First-run onboarding marker. `input: false` keeps it server-only: a
    // client can never POST itself onboarding-complete; only the
    // `completeOnboarding` action writes it.
    user: {
      additionalFields: {
        onboardedAt: {
          input: false,
          required: false,
          type: "date",
        },
      },
    },
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

/** The slice of the worker env better-auth sees. The OTP sender reads its
 * delivery settings from here: leaving them out made every lost-passkey code
 * fall through to the console on a real domain instead of the webhook. */
const authEnv = (env: KitEnv): KitEnv => ({
  BASE_DOMAIN: env.BASE_DOMAIN,
  BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
  BETTER_AUTH_URL: env.BETTER_AUTH_URL,
  NOITE_EMAIL_WEBHOOK_URL: env.NOITE_EMAIL_WEBHOOK_URL,
  NOITE_SMTP_FROM: env.NOITE_SMTP_FROM,
});

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

  return createAuth(authEnv(env), baseURL);
};

export interface SessionUser {
  /** What this session may do to the instance (lib/authority): the one
   * predicate every gate and surface reads. */
  authority: InstanceAuthority;
  email: string;
  id: string;
  /** Set only on an impersonated session (the admin plugin). The onboarding
   * action refuses to mark the target onboarded on such a session. */
  impersonatedBy: string | null;
  name: string;
}

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
