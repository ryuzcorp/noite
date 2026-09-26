import { batch } from "oxidejs";

/** Loads a page's data in one batched action round trip.
 *
 * A workspace page fires one load per card, all in the same paint, and celld
 * does not serve concurrent action requests: it answers one and drops the rest
 * with no response. Measured against the deployed node — a single request is
 * 8/8, 12/12 and 30/30 fine, while thirteen at once lose five to thirteen of
 * thirteen, through the edge and straight to the node alike, and none of
 * `CELLD_ACTIVATIONS`, `MAX_CELL_REQUESTS`, `HANDLER_BUDGET_S`,
 * `IDLE_EVICT_S`, `MAX_RSS_MB`, `PRESSURE_OWNERSHIP` or
 * `MAX_RESIDENT_CELLS` changes it.
 *
 * `batch()` calls each item itself, in its own tick, so a thunk per load is
 * what puts every caller's call into the same JSON-RPC 2.0 batch. Each thunk
 * settles its own caller, so this layer never names a payload type: the
 * caller's generic `T` stays the only contract.
 */
const COALESCE_MS = 8;

/** One queued load: started inside the batch tick, settling its own caller. */
type QueuedLoad = () => Promise<void>;

let queued: QueuedLoad[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

const flush = async (): Promise<void> => {
  const items = queued;
  queued = [];
  timer = null;
  if (items.length === 0) {
    return;
  }
  // Each thunk starts its own call here, which is the tick `batch()` requires;
  // a load that fails therefore rejects only through its own caller below.
  await batch(items);
};

/** Run `load` as part of the current paint's batch. Use this instead of calling
 * an action in a panel's mount path: several panels mounting together then cost
 * one request rather than one each. */
export const batched = <T>(load: () => Promise<T>): Promise<T> =>
  // oxlint-disable-next-line promise/avoid-new -- only a deferred can hand one batched result back to the caller that asked for it.
  new Promise<T>((resolve, reject) => {
    queued.push(async () => {
      try {
        resolve(await load());
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (timer === null) {
      timer = setTimeout(() => {
        flush();
      }, COALESCE_MS);
    }
  });
