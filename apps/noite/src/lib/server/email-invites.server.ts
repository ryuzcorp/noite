import { Data } from "effect";
import { and, eq, isNull, sql } from "void/db";

import {
  emailInviteTable,
  instanceSettingTable,
  userTable,
} from "../../db/schema";
import { controlBaseDomain } from "../control-env";
import { getDb, resolveEnv, withDb } from "../db";
import { isLocalhostDomain } from "../local-host";
import { clientKey, limiterFor } from "../rate-limit";
import type { RateLimitDecision } from "../rate-limit";
import { countUsersAndAdmins, setupModeOf } from "./setup-code.server";
import type { SetupMode } from "./setup-code.server";

//! Instance invitations by email, the waitlist switch, and the registration
//! abuse bounds.
//!
//! SECURITY INVARIANTS (see the PR body for the full statement):
//! 1. Registration has NO mailbox proof, so an email address alone never
//!    grants access. An instance invite is a single-use, expiring (7 days),
//!    unguessable (>=128-bit) token, stored HASHED, bound to the invited
//!    email, and delivered as a link to the control origin. Registration
//!    presenting a valid unexpired token, for the same email
//!    (case-insensitive), creates an ACTIVE account and burns the token
//!    atomically, so two concurrent registrations cannot both use it. If
//!    platform email delivery is configured (the OTP sender's
//!    `NOITE_EMAIL_WEBHOOK_URL`), the link is emailed; either way the admin
//!    can copy it from the UI once, at creation. Only instance admins create,
//!    list or revoke invites.
//! 2. The waitlist is an instance setting (default OFF). With it enabled an
//!    uninvited registration creates a `pending` account that holds no access
//!    until approval; with it disabled the registration is refused and leaves
//!    no rows behind.
//! 3. Sign-up attempts are rate-limited per client IP and pending accounts
//!    are capped, so an open waitlist cannot be flooded without bound.
//!
//! States and transitions (`inviteLifecycle` is the only constructor).
//! `Used` wins over `Revoked`: a spent token can never become reusable,
//! whatever an operator toggles afterwards. `Expired` is derived from the
//! clock, not stored: an expired row that was never revoked still reads
//! `Expired`, and revoking it moves it to `Revoked` (terminal either way).
//!
//! | state       | `revoked` | `usedBy` | `expiresAt` | next states |
//! | ----------- | --------- | -------- | ----------- | ----------- |
//! | `Available` | 0         | NULL     | future      | `Used`, `Revoked` |
//! | `Expired`   | 0         | NULL     | past        | `Revoked` |
//! | `Used`      | any       | id/email | any         | terminal |
//! | `Revoked`   | 1         | NULL     | any         | terminal |
//!
//! The transitions are conditional writes (`redeemEmailInvite` claims with
//! `usedAt IS NULL AND revoked = 0`; `revokeEmailInvite` updates with
//! `usedBy IS NULL`) and each re-reads its row to confirm which state it
//! landed in, so two callers racing on one token cannot both win.

/** How long an emailed invitation stays redeemable. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Upper bound on accounts waiting for approval. Past it, uninvited
 * registration is refused until an admin approves or rejects the queue. */
export const MAX_PENDING_ACCOUNTS = 200;

/** Sign-up attempts per client IP per minute (the `signup` limiter class).
 * The cap above is the hard bound; this blunts bursts before they get there.
 * Sized above what the e2e lane's parallel workers register in a minute. */
export const SIGNUP_RATE_LIMIT = 30;

/** Instance-setting key for the waitlist. */
export const WAITLIST_KEY = "waitlist_enabled";

/** Public signup policy: the very first account bootstraps the instance. On
 * a `localhost`-family base it needs no proof (dev and e2e); on a public
 * base with no admin yet, `setupMode` names the gate: `email` means the
 * `NOITE_ADMIN_EMAIL` address *and* the one-time setup code, `code` means
 * the code alone. `firstRun` and `adminExists` are fast reads, not
 * arbitration points — the bootstrap claim is. */
export const signupPolicy = async (): Promise<{
  adminExists: boolean;
  firstRun: boolean;
  setupMode: SetupMode;
  waitlistEnabled: boolean;
}> => {
  const { admins, users } = await countUsersAndAdmins();

  const firstRun = users === 0;
  const adminExists = admins > 0;

  return {
    adminExists,
    firstRun,
    setupMode: setupModeOf({
      adminEmail: resolveEnv().NOITE_ADMIN_EMAIL?.trim().toLowerCase() || null,
      adminExists,
      baseDomain: controlBaseDomain(),
    }),
    waitlistEnabled: await waitlistEnabled(),
  };
};

/** Whether uninvited registrations queue as `pending` (default OFF:
 * uninvited registration is refused). Absent or malformed rows read as OFF:
 * the strictest posture is the default. */
export const waitlistEnabled = (): Promise<boolean> =>
  withDb(async () => {
    const rows = await getDb()
      .select({ value: instanceSettingTable.value })
      .from(instanceSettingTable)
      .where(eq(instanceSettingTable.key, WAITLIST_KEY))
      .limit(1);

    return rows[0]?.value === "1";
  });

/** Flip the waitlist switch (instance-admin only; the caller gates). */
export const setWaitlistEnabled = (enabled: boolean): Promise<void> =>
  withDb(async () => {
    const db = getDb();
    const now = new Date().toISOString();

    await db
      .insert(instanceSettingTable)
      .values({ key: WAITLIST_KEY, updatedAt: now, value: enabled ? "1" : "0" })
      .onConflictDoUpdate({
        set: { updatedAt: now, value: enabled ? "1" : "0" },
        target: instanceSettingTable.key,
      });
  });

/** A fresh 128-bit invitation token, URL-safe (no padding). */
export const newInviteToken = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
};

/** SHA-256 hex of a token: what lands in the database, so a reader can never
 * redeem an invite. */
export const hashInviteToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** One invitation's state. `Used.by` is the redeemer's email (the account
 * may since have been deleted — the token stays spent). */
export type EmailInviteLifecycle = Data.TaggedEnum<{
  Available: Record<never, never>;
  Expired: Record<never, never>;
  Revoked: Record<never, never>;
  Used: { readonly by: string };
}>;

export const EmailInviteState = Data.taggedEnum<EmailInviteLifecycle>();

/** One wire word per state, for the admin list. */
export type EmailInviteWire = "available" | "expired" | "revoked" | "used";

export const inviteWire = (state: EmailInviteLifecycle): EmailInviteWire => {
  switch (state._tag) {
    case "Available": {
      return "available";
    }

    case "Expired": {
      return "expired";
    }

    case "Revoked": {
      return "revoked";
    }

    default: {
      return "used";
    }
  }
};

interface InviteRow {
  expiresAt: string | null;
  revoked: boolean | null;
  usedBy: string | null;
}

/** The one constructor: row columns plus the clock in, closed state out. */
export const inviteLifecycle = (
  row: InviteRow,
  now: Date = new Date()
): EmailInviteLifecycle => {
  if (row.usedBy !== null) {
    return EmailInviteState.Used({ by: row.usedBy });
  }

  if (row.revoked === true) {
    return EmailInviteState.Revoked();
  }

  if (row.expiresAt !== null && row.expiresAt <= now.toISOString()) {
    return EmailInviteState.Expired();
  }

  return EmailInviteState.Available();
};

/** Deliver an invitation link: POST to the configured webhook (Workers have
 * no SMTP sockets), dev-console fallback on localhost, loud refusal
 * otherwise — the same delivery contract as the sign-in OTP. */
export const sendInviteEmail = async (
  email: string,
  link: string,
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
        link,
        type: "invite",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Invite webhook failed with status ${response.status}`);
    }

    return;
  }

  // Fail closed: a missing base is never localhost (a deployed worker without
  // one is misconfigured), so the send refuses loudly instead of printing to
  // the dev console on a real domain.
  if (isLocalhostDomain(env.BASE_DOMAIN ?? "")) {
    // oxlint-disable-next-line no-console-except-error -- dev-only invite delivery channel; prod uses the webhook or refuses loudly below.
    console.log(`[noite:invite] invitation link for ${email}: ${link}`);

    return;
  }

  throw new Error("Email delivery is not configured (NOITE_EMAIL_WEBHOOK_URL)");
};

/** Tell an approved account it can sign in now: the same webhook contract
 * as the invite (operator-configured URL, localhost console, loud refusal
 * otherwise). The caller decides whether a refusal fails the approval —
 * the account is already active either way. */
export const sendApprovalEmail = async (
  email: string,
  origin: string,
  env: KitEnv
): Promise<void> => {
  const link = `${origin.replace(/\/+$/u, "")}/login`;
  const webhook = env.NOITE_EMAIL_WEBHOOK_URL?.trim();

  if (webhook) {
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
        link,
        type: "approved",
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!response.ok) {
      throw new Error(`Approval webhook failed with status ${response.status}`);
    }

    return;
  }

  if (isLocalhostDomain(env.BASE_DOMAIN ?? "")) {
    // oxlint-disable-next-line no-console-except-error -- dev-only approval channel; prod uses the webhook or refuses loudly below.
    console.log(`[noite:invite] account approved for ${email}: ${link}`);

    return;
  }

  throw new Error("Email delivery is not configured (NOITE_EMAIL_WEBHOOK_URL)");
};

export interface CreatedInvite {
  email: string;
  expiresAt: string;
  id: string;
  /** The one-time link: the token appears here and nowhere else. */
  link: string;
}

/** Mint an invitation for `email`, bound to that address. The token is
 * returned (and linked) once, at creation; only its hash is stored. */
export const createEmailInvite = async (
  email: string,
  createdBy: string,
  origin: string
): Promise<CreatedInvite> => {
  const normalized = email.trim().toLowerCase();
  let base: string;

  try {
    base = new URL(origin).origin;
  } catch {
    throw new Error("Cannot build an invitation link without a valid origin");
  }

  if (!normalized) {
    throw new Error("An email address is required");
  }

  const token = newInviteToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const id = await withDb(async () => {
    const db = getDb();

    const rows = await db
      .insert(emailInviteTable)
      .values({
        createdBy,
        email: normalized,
        expiresAt,
        tokenHash: await hashInviteToken(token),
      })
      .returning({ id: emailInviteTable.id });

    const [row] = rows;

    if (!row) {
      throw new Error("The invitation was not created");
    }

    return row.id;
  });

  return {
    email: normalized,
    expiresAt,
    id,
    link: `${base}/login?invite=${token}`,
  };
};

/** Why a presented token cannot register. `WrongEmail` never burns the
 * token: the real invitee can still use it. */
export type RedeemProblem =
  | "expired"
  | "revoked"
  | "unknown"
  | "used"
  | "wrong-email";

export type RedeemOutcome = Data.TaggedEnum<{
  Ok: { readonly id: string };
  Expired: Record<never, never>;
  Revoked: Record<never, never>;
  Unknown: Record<never, never>;
  Used: Record<never, never>;
  WrongEmail: Record<never, never>;
}>;

export const RedeemResult = Data.taggedEnum<RedeemOutcome>();

/** Validate a token for an email WITHOUT burning it: the gate's pre-check
 * before a user row exists, so a refused registration leaves no rows
 * behind. The atomic burn still happens in `redeemEmailInvite`, which is
 * what decides a race. */
export const checkInviteToken = (
  token: string | undefined,
  email: string
): Promise<RedeemProblem | null> =>
  withDb(async () => {
    if (!token?.trim()) {
      return "unknown";
    }

    const normalized = email.trim().toLowerCase();
    const tokenHash = await hashInviteToken(token.trim());

    const rows = await getDb()
      .select({
        email: emailInviteTable.email,
        expiresAt: emailInviteTable.expiresAt,
        revoked: emailInviteTable.revoked,
        usedBy: emailInviteTable.usedBy,
      })
      .from(emailInviteTable)
      .where(eq(emailInviteTable.tokenHash, tokenHash))
      .limit(1);

    const [row] = rows;

    if (!row) {
      return "unknown";
    }

    const state = inviteLifecycle(
      { expiresAt: row.expiresAt, revoked: row.revoked, usedBy: row.usedBy },
      new Date()
    );

    switch (state._tag) {
      case "Used": {
        return "used";
      }

      case "Revoked": {
        return "revoked";
      }

      case "Expired": {
        return "expired";
      }

      default: {
        break;
      }
    }

    return row.email === normalized ? null : "wrong-email";
  });

/** The confirm re-read after a burn that changed nothing: our write won when
 * the row carries our address; a set `revoked` means a revoke beat us to it;
 * anything else is another registration's win. Pure so the race is a unit
 * test, not timing. Exported for the test. */
export const confirmRedeemOf = (
  after: {
    readonly id: string;
    readonly revoked: boolean;
    readonly usedBy: string | null;
  },
  normalized: string
): RedeemOutcome => {
  if (after.usedBy === normalized) {
    return RedeemResult.Ok({ id: after.id });
  }

  return after.revoked === true ? RedeemResult.Revoked() : RedeemResult.Used();
};

/** Redeem a token for an email. The burn is a conditional write
 * (`usedAt IS NULL AND revoked = 0`) confirmed by a re-read: two concurrent
 * registrations with one token cannot both win, and the loser reads its
 * actual state (`Revoked` when a revoke beat it, else `Used`). */
export const redeemEmailInvite = (
  token: string,
  email: string
): Promise<RedeemOutcome> =>
  withDb(async () => {
    const db = getDb();
    const normalized = email.trim().toLowerCase();
    const tokenHash = await hashInviteToken(token.trim());
    const now = new Date().toISOString();

    const rows = await db
      .select({
        email: emailInviteTable.email,
        expiresAt: emailInviteTable.expiresAt,
        id: emailInviteTable.id,
        revoked: emailInviteTable.revoked,
        usedBy: emailInviteTable.usedBy,
      })
      .from(emailInviteTable)
      .where(eq(emailInviteTable.tokenHash, tokenHash))
      .limit(1);

    const [row] = rows;

    if (!row) {
      return RedeemResult.Unknown();
    }

    const state = inviteLifecycle(
      { expiresAt: row.expiresAt, revoked: row.revoked, usedBy: row.usedBy },
      new Date(now)
    );

    switch (state._tag) {
      case "Used": {
        return RedeemResult.Used();
      }

      case "Revoked": {
        return RedeemResult.Revoked();
      }

      case "Expired": {
        return RedeemResult.Expired();
      }

      default: {
        break;
      }
    }

    if (row.email !== normalized) {
      return RedeemResult.WrongEmail();
    }

    await db
      .update(emailInviteTable)
      .set({ usedAt: now, usedBy: normalized })
      .where(
        and(
          eq(emailInviteTable.id, row.id),
          isNull(emailInviteTable.usedAt),
          eq(emailInviteTable.revoked, false)
        )
      );

    const [after] = await db
      .select({
        id: emailInviteTable.id,
        revoked: emailInviteTable.revoked,
        usedBy: emailInviteTable.usedBy,
      })
      .from(emailInviteTable)
      .where(eq(emailInviteTable.id, row.id))
      .limit(1);

    return after === undefined
      ? RedeemResult.Used()
      : confirmRedeemOf(after, normalized);
  });

/** What a revoke actually did. A spent token is history: the transition is
 * refused instead of silently answering "revoked". */
export type RevokeOutcome = Data.TaggedEnum<{
  Refused: { readonly reason: "missing" | "revoked" | "used" };
  Revoked: Record<never, never>;
}>;

export const RevokeResult = Data.taggedEnum<RevokeOutcome>();

/** Available -> Revoked. Conditional on `usedBy IS NULL`; the re-read names
 * the state the row is actually in, so the caller can report it. */
export const revokeEmailInvite = (id: string): Promise<RevokeOutcome> =>
  withDb(async () => {
    const db = getDb();

    await db
      .update(emailInviteTable)
      .set({ revoked: true })
      .where(and(eq(emailInviteTable.id, id), isNull(emailInviteTable.usedBy)));

    const rows = await db
      .select({
        revoked: emailInviteTable.revoked,
        usedBy: emailInviteTable.usedBy,
      })
      .from(emailInviteTable)
      .where(eq(emailInviteTable.id, id))
      .limit(1);

    const [row] = rows;

    if (!row) {
      return RevokeResult.Refused({ reason: "missing" });
    }

    if (row.usedBy !== null) {
      return RevokeResult.Refused({ reason: "used" });
    }

    return row.revoked === true
      ? RevokeResult.Revoked()
      : RevokeResult.Refused({ reason: "revoked" });
  });

export interface EmailInviteView {
  createdAt: string;
  createdByEmail: string;
  email: string;
  expiresAt: string;
  id: string;
  /** The server's derived state (the only field the panel branches on). */
  state: EmailInviteWire;
  usedAt: string;
  usedByEmail: string;
}

const asIso = (value: string | Date | null | undefined): string =>
  value instanceof Date ? value.toISOString() : String(value ?? "");

/** Every invitation with the addresses on both ends (admin only). */
export const listEmailInvites = (): Promise<EmailInviteView[]> =>
  withDb(async () => {
    const rows = await getDb().all<{
      createdAt: string | null;
      createdByEmail: string | null;
      email: string;
      expiresAt: string | null;
      id: string;
      // Raw SQL bypasses drizzle's boolean mode: SQLite answers 0/1.
      revoked: number | boolean | null;
      usedAt: string | null;
      usedBy: string | null;
      usedByEmail: string | null;
    }>(sql`
      SELECT i.id AS id, i.email AS email,
             i.expiresAt AS expiresAt, i.usedAt AS usedAt, i.usedBy AS usedBy,
             i.revoked AS revoked, i.createdAt AS createdAt,
             c.email AS createdByEmail, COALESCE(u.email, i.usedBy) AS usedByEmail
        FROM email_invite i
   LEFT JOIN "user" c ON c.id = i.createdBy
   LEFT JOIN "user" u ON u.email = i.usedBy
       ORDER BY i.createdAt DESC, i.id
    `);

    const now = new Date();

    return rows.map((row) => ({
      createdAt: asIso(row.createdAt),
      createdByEmail: row.createdByEmail ?? "",
      email: row.email,
      expiresAt: asIso(row.expiresAt),
      id: row.id,
      state: inviteWire(
        inviteLifecycle(
          {
            expiresAt: row.expiresAt,
            revoked: row.revoked === true || row.revoked === 1,
            usedBy: row.usedBy,
          },
          now
        )
      ),
      usedAt: asIso(row.usedAt),
      usedByEmail: row.usedByEmail ?? "",
    }));
  });

/** How many accounts are waiting for approval right now. */
export const countPendingAccounts = (): Promise<number> =>
  withDb(async () => {
    const rows = await getDb().all<{ n: number }>(sql`
      SELECT count(*) AS n FROM "user" WHERE status = 'pending'
    `);

    return rows[0]?.n ?? 0;
  });

/** One account's registration state: `active`, `pending`, or null (no row). */
export const userStatusOf = (
  userId: string
): Promise<"active" | "pending" | null> =>
  withDb(async () => {
    const rows = await getDb()
      .select({ status: userTable.status })
      .from(userTable)
      .where(eq(userTable.id, userId))
      .limit(1);

    const status = rows[0]?.status;

    if (status === "pending") {
      return "pending";
    }

    return status === "active" ? "active" : null;
  });

/** Flip one account's registration state (approve / internal moves). */
export const setUserStatus = (
  userId: string,
  status: "active" | "pending"
): Promise<void> =>
  withDb(async () => {
    await getDb()
      .update(userTable)
      .set({ status })
      .where(eq(userTable.id, userId));
  });

/** Approve a waiting account: flip `pending` -> `active` with a conditional
 * write, so two concurrent approvals cannot both act — the loser reads
 * null. Returns the account's email for the approval notice, or null when
 * the account is not waiting (gone, or already active). */
export const approvePendingUser = (
  userId: string
): Promise<{ email: string } | null> =>
  withDb(async () => {
    const rows = await getDb()
      .update(userTable)
      .set({ status: "active" })
      .where(and(eq(userTable.id, userId), eq(userTable.status, "pending")))
      .returning({ email: userTable.email });

    return rows[0] ?? null;
  });

/** The sign-up abuse bound for one key: the client IP in the gate (`signup`
 * class), the registering address as a fallback when no request is in
 * scope. Exported for the unit test; the registration gate is the only
 * caller. */
export const signupRateDecision = (
  key: string,
  now: number = Date.now()
): RateLimitDecision =>
  limiterFor("signup").decision(key, SIGNUP_RATE_LIMIT, now);

/** The limiter key for one registration attempt: the client IP, as with the
 * other auth limits — falling back to the registering address when no
 * request is in scope, so a missing request never skips the bound. */
export const signupRateKey = (
  request: Request | undefined,
  email: string
): string =>
  request === undefined
    ? `email:${email.trim().toLowerCase()}`
    : clientKey(request);

/** The pre-create verdict for a non-first-run registration: the token is
 * validated without burning it (the atomic burn happens after the user row
 * exists), and uninvited registration is refused — or capped — before any
 * row is created. Unit-tested directly; the passkey gate only maps it onto
 * API errors. */
export type RegistrationGate = Data.TaggedEnum<{
  BadToken: { readonly problem: RedeemProblem };
  Proceed: Record<never, never>;
  Refuse: {
    readonly code:
      | "REGISTRATION_CLOSED"
      | "SIGNUP_RATE_LIMITED"
      | "WAITLIST_FULL";
    readonly message: string;
  };
}>;

export const GateVerdict = Data.taggedEnum<RegistrationGate>();

export const checkRegistrationGate = async (input: {
  email: string;
  invite: string | undefined;
  request: Request | undefined;
  waitlistEnabled: boolean;
}): Promise<RegistrationGate> => {
  const rate = signupRateDecision(signupRateKey(input.request, input.email));

  if (rate._tag === "Denied") {
    return GateVerdict.Refuse({
      code: "SIGNUP_RATE_LIMITED",
      message: "Too many sign-up attempts — try again in a minute.",
    });
  }

  if (input.invite) {
    const problem = await checkInviteToken(input.invite, input.email);

    return problem === null
      ? GateVerdict.Proceed()
      : GateVerdict.BadToken({ problem });
  }

  if (!input.waitlistEnabled) {
    return GateVerdict.Refuse({
      code: "REGISTRATION_CLOSED",
      message:
        "This instance is not accepting new accounts. Ask an admin for an invitation.",
    });
  }

  if ((await countPendingAccounts()) >= MAX_PENDING_ACCOUNTS) {
    return GateVerdict.Refuse({
      code: "WAITLIST_FULL",
      message: "The waiting list is full right now. Try again later.",
    });
  }

  return GateVerdict.Proceed();
};
