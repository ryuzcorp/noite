import { describe, expect, test } from "bun:test";

import type { GithubSyncOutcome, GithubSyncStatus } from "../runner";
import {
  cancelConfirm,
  confirmSync,
  isConfirmRequired,
  requestSync,
  syncFailed,
  syncSucceeded,
} from "./github-sync.machine";

const status = (patch: Partial<GithubSyncStatus> = {}): GithubSyncStatus => ({
  currentTip: "tip",
  imported: true,
  lastSyncSha: "base",
  noiteCommits: 0,
  originTip: null,
  owner: "octocat",
  path: null,
  ref: "main",
  repo: "Hello-World",
  ...patch,
});

const synced = (): GithubSyncOutcome => ({
  noiteOverwritten: 2,
  originSha: "origin",
  sha: "new",
  status: "synced",
});

const upToDate = (): GithubSyncOutcome => ({
  originSha: "origin",
  sha: "same",
  status: "upToDate",
});

describe("github sync request", () => {
  test("a clean tree syncs without asking first", () => {
    const next = requestSync(status({ noiteCommits: 0 }));

    expect(next._tag).toBe("Syncing");
    expect(next).toMatchObject({ confirm: false });
  });

  test("Noite commits open the overwrite confirmation", () => {
    const next = requestSync(status({ noiteCommits: 3 }));

    expect(next._tag).toBe("Confirming");
  });

  test("confirming syncs with confirm, cancelling returns to idle", () => {
    expect(confirmSync(status())._tag).toBe("Syncing");
    expect(confirmSync(status())).toMatchObject({ confirm: true });
    expect(cancelConfirm(status())._tag).toBe("Idle");
  });
});

describe("github sync resolution", () => {
  test("a new commit lands in Synced with its sha", () => {
    const next = syncSucceeded(status(), synced());

    expect(next._tag).toBe("Synced");
    expect(next).toMatchObject({ noiteOverwritten: 2, sha: "new" });
  });

  test("an unchanged origin lands in UpToDate", () => {
    const next = syncSucceeded(status(), upToDate());

    expect(next._tag).toBe("UpToDate");
    expect(next).toMatchObject({ sha: "same" });
  });

  test("the overwrite 409 re-opens the confirmation instead of failing", () => {
    const message =
      "2 Noite commits will be overwritten in the tree; they stay in history. Retry the sync with confirm.";

    expect(isConfirmRequired(message)).toBe(true);
    expect(syncFailed(status(), message)._tag).toBe("Confirming");
  });

  test("any other refusal is a failure with the runner's message", () => {
    const message = "tip moved from tip to other; retry the sync";

    expect(isConfirmRequired(message)).toBe(false);

    const next = syncFailed(status(), message);

    expect(next._tag).toBe("Failed");
    expect(next).toMatchObject({ message });
  });
});
