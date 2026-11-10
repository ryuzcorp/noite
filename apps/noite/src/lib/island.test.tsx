import { describe, expect, test } from "bun:test";

import { defineApp } from "@ilha/model";
import { Data } from "effect";
import { renderHtml } from "ilha/test";

import { islandProps } from "./island";

type Message = Data.TaggedEnum<{ Bumped: Record<never, never> }>;

const Msg = Data.taggedEnum<Message>();

interface Model {
  readonly count: number;
}

const Props = islandProps<{ label: string; start: number }>("Counter");

const Counter = Props.wrap(
  defineApp({
    init: () => ({ model: { count: Props.read().start } }),
    update: (model: Model, message: Message) =>
      Msg.$match(message, {
        Bumped: () => ({ model: { count: model.count + 1 } }),
      }),
    view: (model: Model) => (
      <p>
        {Props.read().label}:{model.count}
      </p>
    ),
  })
);

// Named (not inline): renderHtml resolves anonymous closures without their
// imports, so only a module-level component renders the real tree.
const Probe = () => <Counter label="deploys" start={3} />;

describe("islandProps", () => {
  test("init seeds the model from the props and view reads them", async () => {
    const html = await renderHtml(Probe);

    expect(html).toContain("deploys:3");
  });
});
