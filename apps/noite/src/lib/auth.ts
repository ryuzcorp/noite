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

import { ensureDbPromise, getAuthDb, missingDb, orm, resolveEnv } from "./db";

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

// oxlint-disable-next-line unicorn/throw-new-error -- Schema.TaggedError factory
class InvalidRegistrationContextError extends Schema.TaggedError<InvalidRegistrationContextError>()(
  "InvalidRegistrationContextError",
  { message: Schema.String }
) {}

const RegistrationContext = Schema.Struct({
  email: Schema.String,
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
    return { email, name };
  });

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

export const createAuth = (env: KitEnv, baseURL: string) =>
  betterAuth({
    advanced: {
      database: {
        validateSchema: false,
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
            const user = await ctx.context.internalAdapter.createUser(
              {
                email: parsed.email,
                emailVerified: true,
                name: parsed.name,
              },
              { method: "passkey" }
            );
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
    secret: env.BETTER_AUTH_SECRET,
  });

export const authFromEnv = (env: KitEnv, origin: string) => {
  if (!env.BETTER_AUTH_SECRET) {
    throw new MissingAuthSecretError({
      message: "noite: BETTER_AUTH_SECRET is missing",
    });
  }
  return createAuth(
    {
      BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: env.BETTER_AUTH_URL,
    },
    env.BETTER_AUTH_URL ?? origin
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
    return createAuth(
      {
        BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: env.BETTER_AUTH_URL,
      },
      env.BETTER_AUTH_URL ?? origin
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
export const isUserAdminById = (userId: string) =>
  Effect.gen(function* run() {
    const user = yield* orm.user.findFirst({ where: { id: userId } });
    if (!user) {
      return false;
    }
    if (user.role === "admin") {
      return true;
    }
    const anchored = resolveEnv().NOITE_ADMIN_EMAIL?.trim().toLowerCase();
    if (!anchored) {
      return false;
    }
    return user.email.trim().toLowerCase() === anchored;
  });

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
