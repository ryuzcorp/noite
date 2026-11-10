import { describe, expect, test } from "bun:test";

import { Session, sessionTransition } from "./terminal-session";
import type { SessionEvent, SessionState } from "./terminal-session";

const step = (state: SessionState, event: SessionEvent): SessionState =>
  sessionTransition(state, event);

describe("sessionTransition", () => {
  test("a shell is ready only after the frame answered", () => {
    const attached = step(Session.Idle(), { t: "attach" });
    const building = step(attached, { t: "build" });

    expect(attached).toEqual(Session.Attached());
    expect(building).toEqual(Session.Building());
    expect(step(building, { t: "built" })).toEqual(Session.Ready());
  });

  test("a dead frame turns a ready shell into a failure", () => {
    const ready = step(
      step(step(Session.Idle(), { t: "attach" }), { t: "build" }),
      { t: "built" }
    );

    const dead = step(ready, { message: "the workspace stopped", t: "failed" });

    expect(dead).toEqual(Session.Failed({ message: "the workspace stopped" }));
  });

  test("a failed build keeps its message until another checkout attaches", () => {
    const failed = step(Session.Idle(), { message: "no wasm", t: "failed" });

    expect(step(failed, { t: "build" })).toEqual(Session.Building());
    expect(step(failed, { t: "built" })).toEqual(failed);
    expect(step(failed, { t: "attach" })).toEqual(Session.Attached());
  });

  test("a hidden panel keeps the ready shell; a detach drops it", () => {
    const ready = step(
      step(step(Session.Idle(), { t: "attach" }), { t: "build" }),
      { t: "built" }
    );

    expect(ready).toEqual(Session.Ready());
    expect(step(ready, { t: "detach" })).toEqual(Session.Idle());
  });

  test("a build that starts before a mount still ends ready", () => {
    expect(step(Session.Idle(), { t: "build" })).toEqual(Session.Building());
  });
});
