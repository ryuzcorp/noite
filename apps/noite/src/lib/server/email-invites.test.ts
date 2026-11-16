import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestD1 } from "../../testing/d1";
import type { TestD1 } from "../../testing/d1";
import { ensureDb, setD1Binding } from "../db";
import { resetPlatformLimits } from "../rate-limit";
import {
  INVITE_TTL_MS,
  MAX_PENDING_ACCOUNTS,
  SIGNUP_RATE_LIMIT,
  approvePendingUser,
  checkInviteToken,
  confirmRedeemOf,
  countPendingAccounts,
  createEmailInvite,
  hashInviteToken,
  listEmailInvites,
  newInviteToken,
  redeemEmailInvite,
  revokeEmailInvite,
  setUserStatus,
  setWaitlistEnabled,
  signupPolicy,
  signupRateDecision,
  userStatusOf,
  waitlistEnabled,
} from "./email-invites.server";

let db: TestD1;

beforeAll(async () => {
  db = createTestD1();
  setD1Binding(db.d1);
  await ensureDb();
});

beforeEach(() => {
  db.raw.run(`DELETE FROM email_invite`);
  db.raw.run(`DELETE FROM instance_setting`);
  db.raw.run(`DELETE FROM "user"`);
  resetPlatformLimits();
});

const addUser = (id: string, status = "active") => {
  db.raw.run(
    `INSERT INTO "user" (id, name, email, status) VALUES (?, ?, ?, ?)`,
    [id, id, `${id}@example.com`, status]
  );
};

describe("tokens", () => {
  test("a token carries 128 bits of entropy in URL-safe text", () => {
    const token = newInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(newInviteToken()).not.toBe(token);
  });

  test("the hash is deterministic, hex, and never the token", async () => {
    const token = newInviteToken();
    const hash = await hashInviteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashInviteToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });
});

describe("signup policy", () => {
  test("the first account bootstraps the instance; the waitlist is off by default", async () => {
    expect(await waitlistEnabled()).toBe(false);
    const before = await signupPolicy();
    expect(before.firstRun).toBe(true);
    expect(before.adminExists).toBe(false);
    expect(before.waitlistEnabled).toBe(false);
    addUser("first");
    const policy = await signupPolicy();
    expect(policy.firstRun).toBe(false);
    expect(policy.adminExists).toBe(false);
  });

  test("the waitlist switch round-trips through the policy", async () => {
    addUser("admin");
    await setWaitlistEnabled(true);
    expect(await waitlistEnabled()).toBe(true);
    const policy = await signupPolicy();
    expect(policy.waitlistEnabled).toBe(true);
    await setWaitlistEnabled(false);
    expect(await waitlistEnabled()).toBe(false);
  });
});

describe("createEmailInvite", () => {
  test("an invite binds the lowercased email and stores only the hash", async () => {
    addUser("admin");

    const created = await createEmailInvite(
      "Friend@Example.com",
      "admin",
      "https://app.example.com"
    );

    expect(created.email).toBe("friend@example.com");
    expect(created.link).toMatch(
      /^https:\/\/app\.example\.com\/login\?invite=[A-Za-z0-9_-]{22}$/u
    );
    expect(
      new Date(created.expiresAt).getTime() - Date.now()
    ).toBeLessThanOrEqual(INVITE_TTL_MS);

    // SAFETY: created above, so exactly one row carries its hash.
    const row = db.raw
      .query(`SELECT email, tokenHash FROM email_invite WHERE id = ?`)
      .get(created.id) as { email: string; tokenHash: string };

    expect(row.email).toBe("friend@example.com");
    expect(row.tokenHash).toBe(await hashInviteToken(tokenOf(created.link)));
    expect(row.tokenHash).not.toContain(tokenOf(created.link));
  });

  test("a blank email is refused before a row lands", async () => {
    addUser("admin");
    await expect(
      createEmailInvite("   ", "admin", "https://x.example")
    ).rejects.toThrow();

    // SAFETY: `count(*)` always returns exactly one `{ n }` row.
    const count = db.raw
      .query(`SELECT count(*) AS n FROM email_invite`)
      .get() as {
      n: number;
    };

    expect(count.n).toBe(0);
  });
});

const tokenOf = (link: string): string => {
  const token = new URL(link).searchParams.get("invite") ?? "";
  expect(token).not.toBe("");

  return token;
};

describe("redeemEmailInvite", () => {
  test("a valid token for the same email (any case) redeems once", async () => {
    addUser("admin");

    const { link } = await createEmailInvite(
      "friend@example.com",
      "admin",
      "https://x.example"
    );

    const token = tokenOf(link);
    const first = await redeemEmailInvite(token, "Friend@Example.com");
    expect(first._tag).toBe("Ok");
    const second = await redeemEmailInvite(token, "friend@example.com");
    expect(second._tag).toBe("Used");
  });

  test("an unknown token is refused", async () => {
    const verdict = await redeemEmailInvite(newInviteToken(), "a@example.com");
    expect(verdict._tag).toBe("Unknown");
  });

  test("a token for another address never grants access", async () => {
    addUser("admin");

    const { link } = await createEmailInvite(
      "friend@example.com",
      "admin",
      "https://x.example"
    );

    const verdict = await redeemEmailInvite(
      tokenOf(link),
      "stranger@example.com"
    );

    expect(verdict._tag).toBe("WrongEmail");
    // The invite survives a wrong-email attempt: the real invitee can still use it.
    const retry = await redeemEmailInvite(tokenOf(link), "friend@example.com");
    expect(retry._tag).toBe("Ok");
  });

  test("expired and revoked tokens are refused with their reason", async () => {
    addUser("admin");

    const first = await createEmailInvite(
      "a@example.com",
      "admin",
      "https://x.example"
    );

    const second = await createEmailInvite(
      "b@example.com",
      "admin",
      "https://x.example"
    );

    db.raw.run(`UPDATE email_invite SET expiresAt = ? WHERE id = ?`, [
      new Date(Date.now() - 1000).toISOString(),
      first.id,
    ]);
    const revoked = await revokeEmailInvite(second.id);
    expect(revoked._tag).toBe("Revoked");

    const expired = await redeemEmailInvite(
      tokenOf(first.link),
      "a@example.com"
    );

    expect(expired._tag).toBe("Expired");

    const refused = await redeemEmailInvite(
      tokenOf(second.link),
      "b@example.com"
    );

    expect(refused._tag).toBe("Revoked");
  });

  test("only one of two racing redemptions wins", async () => {
    addUser("admin");

    const { link } = await createEmailInvite(
      "friend@example.com",
      "admin",
      "https://x.example"
    );

    const token = tokenOf(link);

    const [first, second] = await Promise.all([
      redeemEmailInvite(token, "friend@example.com"),
      redeemEmailInvite(token, "friend@example.com"),
    ]);

    expect(
      [first._tag, second._tag].filter((tag) => tag === "Ok")
    ).toHaveLength(1);
  });

  test("a revoke that wins the race reports Revoked, not Used", () => {
    expect(
      confirmRedeemOf(
        { id: "i-1", revoked: true, usedBy: null },
        "a@example.com"
      )._tag
    ).toBe("Revoked");
    expect(
      confirmRedeemOf(
        { id: "i-1", revoked: false, usedBy: "b@example.com" },
        "a@example.com"
      )._tag
    ).toBe("Used");
    expect(
      confirmRedeemOf(
        { id: "i-1", revoked: false, usedBy: "a@example.com" },
        "a@example.com"
      )
    ).toMatchObject({ _tag: "Ok", id: "i-1" });
  });
});

describe("revokeEmailInvite", () => {
  test("it reports what it did", async () => {
    addUser("admin");

    const live = await createEmailInvite(
      "a@example.com",
      "admin",
      "https://x.example"
    );

    const spent = await createEmailInvite(
      "b@example.com",
      "admin",
      "https://x.example"
    );

    const redeemed = await redeemEmailInvite(
      tokenOf(spent.link),
      "b@example.com"
    );

    expect(redeemed._tag).toBe("Ok");

    const revokedLive = await revokeEmailInvite(live.id);
    expect(revokedLive._tag).toBe("Revoked");
    const used = await revokeEmailInvite(spent.id);
    expect(used._tag).toBe("Refused");
    const missing = await revokeEmailInvite("no-such-id");
    expect(missing._tag).toBe("Refused");
  });
});

describe("listEmailInvites", () => {
  test("rows carry the derived lifecycle", async () => {
    addUser("admin");

    const live = await createEmailInvite(
      "live@example.com",
      "admin",
      "https://x.example"
    );

    const spent = await createEmailInvite(
      "spent@example.com",
      "admin",
      "https://x.example"
    );

    const redeemed = await redeemEmailInvite(
      tokenOf(spent.link),
      "spent@example.com"
    );

    expect(redeemed._tag).toBe("Ok");
    const rows = await listEmailInvites();
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(live.id)?.state).toBe("available");
    expect(byId.get(live.id)?.email).toBe("live@example.com");
    expect(byId.get(spent.id)?.state).toBe("used");
    expect(byId.get(spent.id)?.usedByEmail).toBe("spent@example.com");
  });
});

describe("waitlist accounting", () => {
  test("pending accounts count toward the cap", async () => {
    addUser("active");
    addUser("waiting", "pending");
    expect(await countPendingAccounts()).toBe(1);
    expect(await userStatusOf("waiting")).toBe("pending");
    expect(await userStatusOf("active")).toBe("active");
    expect(await userStatusOf("ghost")).toBeNull();
    await setUserStatus("waiting", "active");
    expect(await countPendingAccounts()).toBe(0);
  });

  test("the cap is 200", () => {
    expect(MAX_PENDING_ACCOUNTS).toBe(200);
  });
});

describe("approvePendingUser", () => {
  test("exactly one of two racing approvals wins", async () => {
    addUser("waiting", "pending");

    const [first, second] = await Promise.all([
      approvePendingUser("waiting"),
      approvePendingUser("waiting"),
    ]);

    const winners = [first, second].filter((result) => result !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toEqual({ email: "waiting@example.com" });
    expect(await userStatusOf("waiting")).toBe("active");
  });

  test("accounts that are not waiting approve to nothing", async () => {
    addUser("active");
    expect(await approvePendingUser("active")).toBeNull();
    expect(await approvePendingUser("ghost")).toBeNull();
  });
});

describe("signup rate limit", () => {
  test("a burst past the budget is denied on the same key", () => {
    for (let i = 0; i < SIGNUP_RATE_LIMIT; i += 1) {
      expect(signupRateDecision("9.9.9.9")._tag).toBe("Allowed");
    }

    const denied = signupRateDecision("9.9.9.9");
    expect(denied._tag).toBe("Denied");
    // Another client is unaffected by the first one's burst.
    expect(signupRateDecision("8.8.8.8")._tag).toBe("Allowed");
  });
});

describe("checkInviteToken", () => {
  test("a usable token passes; anything else names its problem without burning", async () => {
    addUser("admin");

    const { link } = await createEmailInvite(
      "friend@example.com",
      "admin",
      "https://x.example"
    );

    const token = tokenOf(link);
    expect(await checkInviteToken(token, "friend@example.com")).toBeNull();
    expect(await checkInviteToken(token, "stranger@example.com")).toBe(
      "wrong-email"
    );
    expect(await checkInviteToken("not-a-token", "friend@example.com")).toBe(
      "unknown"
    );
    expect(await checkInviteToken(undefined, "friend@example.com")).toBe(
      "unknown"
    );
    // Nothing burned: the real invitee still redeems.
    const redeemed = await redeemEmailInvite(token, "friend@example.com");
    expect(redeemed._tag).toBe("Ok");
  });
});
