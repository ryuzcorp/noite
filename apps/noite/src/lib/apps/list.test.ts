import { describe, expect, test } from "bun:test";

import { answerInvite, Invite } from "./list";

describe("the invitations banner's answer state", () => {
  test("an answer starts, then resolves back to idle", () => {
    const started = answerInvite(Invite.Idle(), {
      _tag: "Answering",
      accept: true,
      id: "inv-1",
    });

    expect(started).toEqual(Invite.Answering({ accept: true, id: "inv-1" }));

    expect(answerInvite(started, { _tag: "Answered" })).toEqual(Invite.Idle());
  });

  test("a failure keeps the invitation that produced it, and the next answer clears it", () => {
    const failed = answerInvite(
      Invite.Answering({ accept: false, id: "inv-1" }),
      {
        _tag: "Failed",
        error: "gone",
        id: "inv-1",
      }
    );

    expect(failed).toEqual(Invite.Failed({ error: "gone", id: "inv-1" }));

    // A retry of the same invitation replaces the error, so the row shows the
    // new attempt rather than the previous one.
    expect(
      answerInvite(failed, { _tag: "Answering", accept: false, id: "inv-1" })
    ).toEqual(Invite.Answering({ accept: false, id: "inv-1" }));
  });
});
