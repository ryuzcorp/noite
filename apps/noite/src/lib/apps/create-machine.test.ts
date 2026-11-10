import { describe, expect, spyOn, test } from "bun:test";

import type { UpdateResult } from "@ilha/model";
import { runCommands } from "@ilha/model/test";
import { Effect } from "effect";

import type { CreateModel, Message } from "./create-machine";
import {
  createSourceOf,
  initialModel,
  Msg,
  statusOf,
  update,
} from "./create-machine";
import type { ProjectUpload } from "./folder-drop";

const UPLOAD: ProjectUpload = {
  bytes: 4,
  files: [{ content: "{}", path: "package.json" }],
  name: "shop",
};

/** A model with nothing in flight, built from the real initial state so a new
 * field cannot be forgotten here. */
const model = (patch: Partial<CreateModel> = {}): CreateModel => ({
  ...initialModel(),
  mounted: true,
  name: "Shop",
  slug: "shop",
  ...patch,
});

/** Run one update's command against a stubbed `fetch`, collecting what the
 * network saw and where the page was sent. */
const run = async (result: UpdateResult<CreateModel, Message>) => {
  const calls: string[] = [];

  // The create and the commit answer the same shape here; the two commands only
  // need a body the callers can read.
  const respond: typeof fetch = Object.assign(
    (input: URL | RequestInfo) => {
      calls.push(String(input));

      return Promise.resolve(Response.json({ id: "app-1", sha: "abc1234" }));
    },
    { preconnect: () => {} }
  );

  const spy = spyOn(globalThis, "fetch").mockImplementation(respond);

  try {
    const messages = await Effect.runPromise(runCommands(result));

    return { calls, messages };
  } finally {
    spy.mockRestore();
  }
};

describe("the create page's state machine", () => {
  test("a stranded app is uploaded into, never created a second time", async () => {
    // The app exists and its upload failed: pressing Create again must not
    // create another app — it must retry the commit into the one that exists.
    const stranded = model({
      source: { t: "Folder", upload: UPLOAD },
      submit: {
        error:
          "The app was created, but the folder could not be committed: boom",
        strandedAppId: "app-1",
        t: "Failed",
      },
    });

    const navigated: string[] = [];

    const next = update(
      stranded,
      Msg.Submitted({ navigate: (href) => navigated.push(href) })
    );

    expect(statusOf(stranded).retrying).toBe(true);
    expect(next.model.submit).toEqual({ appId: "app-1", t: "Committing" });
    expect(statusOf(next.model).busy).toBe(true);

    const { calls } = await run(next);

    expect(calls).not.toContain("/api/apps/create");
    expect(calls).toEqual(["/api/apps/app-1/source/commit"]);
  });

  test("removing the folder does not re-open the create path for a stranded app", async () => {
    const stranded = model({
      source: { t: "Folder", upload: UPLOAD },
      submit: { error: "upload failed", strandedAppId: "app-1", t: "Failed" },
    });

    const removed = update(stranded, Msg.FolderRemoved());

    expect(removed.model.source).toEqual({ t: "None" });
    // The link to the app that exists stays.
    expect(statusOf(removed.model).stranded).toBe("app-1");

    const next = update(removed.model, Msg.Submitted({ navigate: () => {} }));

    expect(next.cmd).toBeUndefined();
    expect(next.model.submit.t).toBe("Failed");
    expect(statusOf(next.model).stranded).toBe("app-1");

    const { calls } = await run(next);

    expect(calls).toEqual([]);
  });

  test("a first submit still creates the app, then commits the folder", async () => {
    const fresh = model({ source: { t: "Folder", upload: UPLOAD } });
    const next = update(fresh, Msg.Submitted({ navigate: () => {} }));

    expect(next.model.submit).toEqual({ t: "Creating" });

    const { calls, messages } = await run(next);

    expect(calls).toEqual(["/api/apps/create"]);
    expect(messages).toEqual([
      Msg.Created({ appId: "app-1", navigate: expect.any(Function) }),
    ]);
  });

  test("a folder still being read blocks the submit, and a late read cannot un-idle a create", () => {
    const reading = update(
      model(),
      Msg.FolderDropped({ name: "shop", reads: Promise.resolve([]) })
    );

    expect(reading.model.drop).toEqual({ t: "Reading" });

    const refused = update(
      reading.model,
      Msg.Submitted({ navigate: () => {} })
    );

    expect(refused.cmd).toBeUndefined();
    expect(refused.model.submit).toEqual({ t: "Idle" });

    // The read lands while a create is already in flight: it must not touch it.
    const creating = model({ submit: { t: "Creating" } });

    const late = update(
      creating,
      Msg.FolderRead({ result: { upload: UPLOAD } })
    );

    expect(late.model.submit).toEqual({ t: "Creating" });
    expect(late.model.source).toEqual({ t: "None" });
    expect(late.cmd).toBeUndefined();
  });

  test("a second submit while creating starts nothing", () => {
    const creating = model({ submit: { t: "Creating" } });
    const next = update(creating, Msg.Submitted({ navigate: () => {} }));

    expect(next.cmd).toBeUndefined();
    expect(next.model.submit).toEqual({ t: "Creating" });
  });

  test("a slug verdict is only ever read for the slug it checked", () => {
    const typed = update(
      model({ slug: "" }),
      Msg.SlugChanged({ value: "shop" })
    );

    const checking = typed.model;

    expect(checking.slugCheck).toEqual({ for: "shop", status: "checking" });
    expect(statusOf(checking).verdict).toBeNull();

    // An answer that arrives after the field moved on is not this slug's.
    const late = update(
      checking,
      Msg.SlugChecked({
        result: { error: "taken", gitRemote: "", host: "", suggestion: null },
        slug: "shop",
      })
    );

    expect(late.model.slugCheck).toEqual({
      for: "shop",
      result: { error: "taken", gitRemote: "", host: "", suggestion: null },
      status: "done",
    });

    const movedOn = update(checking, Msg.SlugChanged({ value: "shoppe" }));

    expect(statusOf(movedOn.model).verdict).toBeNull();

    const stale = update(
      movedOn.model,
      Msg.SlugChecked({
        result: { error: "taken", gitRemote: "", host: "", suggestion: null },
        slug: "shop",
      })
    );

    expect(statusOf(stale.model).verdict).toBeNull();
    expect(stale.model.slugCheck).toEqual({
      for: "shoppe",
      status: "checking",
    });
  });

  test("a taken slug refuses the submit instead of creating", () => {
    const taken = model({
      slugCheck: {
        for: "shop",
        result: {
          error: "shop is taken",
          gitRemote: "",
          host: "",
          suggestion: "shop-2",
        },
        status: "done",
      },
    });

    const next = update(taken, Msg.Submitted({ navigate: () => {} }));

    expect(next.model.submit).toEqual({ t: "Idle" });
    expect(next.cmd).toBeDefined();
  });

  test("a dropped folder wins over the mode picker", () => {
    // The picker is not even on screen while a folder is held, but a mode value
    // that contradicts the source must not change what is created: the folder
    // is created as a blank app and committed after.
    const contradictory = model({
      mode: "import",
      source: { t: "Folder", upload: UPLOAD },
      url: "",
    });

    expect(createSourceOf(contradictory)).toEqual({
      source: { kind: "blank" },
    });

    // Without the folder the same mode does need a URL.
    expect(createSourceOf(model({ mode: "import", url: "" }))).toEqual({
      error:
        "Enter a public GitHub repository URL, e.g. https://github.com/owner/repo",
    });
  });

  test("removing the folder puts the picker back where it started", () => {
    const dropped = model({
      mode: "template",
      slugOrigin: "folder",
      source: { t: "Folder", upload: UPLOAD },
    });

    const removed = update(dropped, Msg.FolderRemoved());

    expect(removed.model.source).toEqual({ t: "None" });
    expect(removed.model.mode).toBe("blank");
    expect(removed.model.slugOrigin).toBe("name");
    expect(removed.model.slug).toBe("shop");
  });

  test("a refused drop says why, and the next drop clears it", () => {
    const refused = update(model(), Msg.DropRefused());

    expect(statusOf(refused.model).error).toBe(
      "Drop one folder: your project's root."
    );
    expect(refused.model.drop).toEqual({ t: "Idle" });

    const reading = update(
      refused.model,
      Msg.FolderDropped({ name: "shop", reads: Promise.resolve([]) })
    );

    expect(reading.model.drop).toEqual({ t: "Reading" });
    expect(statusOf(reading.model).error).toBeNull();
  });

  test("a failed upload keeps the app reachable and the error on the button", () => {
    const failed = update(
      model({
        source: { t: "Folder", upload: UPLOAD },
        submit: { appId: "app-1", t: "Committing" },
      }),
      Msg.CommitFailed({ appId: "app-1", error: "denied" })
    );

    expect(statusOf(failed.model)).toMatchObject({
      busy: false,
      retrying: true,
      stranded: "app-1",
    });
    expect(statusOf(failed.model).error).toContain("denied");
  });
});
