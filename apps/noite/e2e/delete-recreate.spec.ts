import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { deleteApp, findAppId, runnerApi, runnerCall } from "./helpers";

// The delete → re-create cycle (owner report, 2026-11-12, alpha.33): deleting an
// app left its host answering the "paused" page, and re-creating the slug (or
// even creating an unrelated one) failed for minutes while the runner wiped the
// old app's prefixes. The delete now drops the row and frees the slug before the
// wipe starts, so all of this has to hold within the delete call itself.
const control = process.env.E2E_BASE_URL ?? "http://noite.localhost:8090";

/** Every app this spec creates, dropped afterwards: the account's app quota is
 * shared by the whole lane, and a leftover slug fails the next run's create. */
const createdApps: string[] = [];

test.afterAll(async ({ request }) => {
  for (const slug of createdApps.splice(0)) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete at a time; each wipes a prefix on the runner
    await deleteApp(request, slug);
  }
});

interface RunnerAppRow {
  id: string;
  slug: string;
}

const createApp = async (
  request: APIRequestContext,
  name: string,
  slug: string
): Promise<string> => {
  const created = await runnerCall(request, "/v1/apps", {
    body: { name, slug },
    method: "POST",
  });

  expect([200, 201], `create ${slug}: ${String(created.body)}`).toContain(
    created.status
  );

  const id = await findAppId(request, slug);

  expect(id, `create ${slug}: the app is listed`).not.toBeNull();

  return id ?? "";
};

const hostPage = async (
  request: APIRequestContext,
  host: string
): Promise<{ body: string; status: number }> => {
  const res = await request.get(`${control}/`, { headers: { host } });

  return { body: await res.text(), status: res.status() };
};

test(
  "deleting an app frees its host and its slug at once",
  { tag: "@fast" },
  async ({ request }) => {
    createdApps.push("recycle", "recycle-other");
    const firstId = await createApp(request, "Recycle", "recycle");

    const removed = await runnerCall(request, `/v1/apps/${firstId}`, {
      method: "DELETE",
    });

    // The row is gone when the delete answers: 204 (finished) at worst 202
    // (only the best-effort cleanup is still running, the row is already
    // gone), never a failure that leaves the slug taken.
    expect([200, 202, 204]).toContain(removed.status);
    expect(await findAppId(request, "recycle")).toBeNull();

    // The host must read as an unknown app, not as a paused one: the row the
    // "paused" page came from is gone before the answer.
    const gone = await hostPage(request, "recycle.noite.localhost");

    expect(gone.status).toBe(404);
    expect(gone.body).not.toContain("paused");
    expect(gone.body).toContain("no app for this slug");

    // Re-create the same slug immediately, and an unrelated one in the same
    // breath: neither waits on the deleted app's background wipe.
    const againId = await createApp(request, "Recycle", "recycle");
    expect(againId).not.toBe(firstId);

    const otherId = await createApp(request, "Recycle Other", "recycle-other");

    // Both are real rows the API can read back, and the re-created slug owns
    // its host again.
    const listed = await runnerApi<RunnerAppRow[]>(request, "/v1/apps");
    expect(listed.map((app) => app.slug)).toEqual(
      expect.arrayContaining(["recycle", "recycle-other"])
    );

    const readBack = await runnerApi<RunnerAppRow>(
      request,
      `/v1/apps/${againId}`
    );

    expect(readBack.slug).toBe("recycle");

    // A never-deployed app answers "not deployed yet", not a 404 for another
    // app and not the paused page: the edge table resolved the new row.
    const recreated = await hostPage(request, "recycle.noite.localhost");
    expect(recreated.status).toBe(404);
    expect(recreated.body).toContain("Not deployed yet");

    expect(await findAppId(request, "recycle-other")).toBe(otherId);
  }
);
