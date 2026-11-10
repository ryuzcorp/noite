import { describe, expect, test } from "bun:test";

import { MAX_TOASTS, nextToasts } from "./toast";
import type { Toast } from "./toast";

const toast = (id: number, text = `t${id}`): Toast => ({ id, text });

describe("toast queue", () => {
  test("push appends, expire removes by id", () => {
    const first = nextToasts([], { id: 1, text: "saved" });
    expect(first).toEqual([toast(1, "saved")]);

    const second = nextToasts(first, { id: 2, text: "deleted" });
    expect(second).toHaveLength(2);

    expect(nextToasts(second, { id: 1 })).toEqual([toast(2, "deleted")]);
  });

  test("the queue is bounded and drops the oldest", () => {
    let queue: Toast[] = [];

    for (let id = 1; id <= MAX_TOASTS + 2; id += 1) {
      queue = nextToasts(queue, { id, text: `t${id}` });
    }

    expect(queue).toHaveLength(MAX_TOASTS);
    expect(queue.at(0)?.id).toBe(3);
    expect(queue.at(-1)?.id).toBe(MAX_TOASTS + 2);
  });

  test("an already-shown id is not duplicated", () => {
    const queue = nextToasts([toast(1)], { id: 1, text: "again" });

    expect(queue).toHaveLength(1);
    expect(queue[0]?.text).toBe("t1");
  });
});
