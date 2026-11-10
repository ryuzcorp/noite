import { expect, test } from "bun:test";

import { staleBase } from "./stale-base";

const BASE = "1111111";
const TIP = "2222222";

test("the base and the tip are two distinct values", () => {
  const stale = staleBase(TIP, BASE);

  expect(stale).toEqual({ baseSha: BASE, tipSha: TIP });
  // The panel names the commit the work is based on, never the tip it moved
  // past (the old shape published the base under `stale`, the workspace's own
  // word for the tip).
  expect(stale?.baseSha).not.toBe(stale?.tipSha);
});

test("a pod on the browsed tip is not stale", () => {
  expect(staleBase(null, BASE)).toBeNull();
});
