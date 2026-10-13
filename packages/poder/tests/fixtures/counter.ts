// Test fixture: port of the `Counter` class from apps/noite/test/index.ts
// (same counting semantics, including the `?read=1` probe).
import type {
  DurableObjectContext,
  PoderDurableObjectNamespace,
} from "../../src/durable-objects/namespace.ts";
import { isNumber } from "../../src/guards.ts";

interface CounterBody {
  n: number;
  url: string;
}

/** What `Counter.fetch` answers for a counting request. */
export class Counter {
  private readonly state: DurableObjectContext;

  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test double mirrors the DO constructor contract.
  constructor(state: DurableObjectContext, _env: Record<string, unknown>) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const stored = await this.state.storage.get("n");
    const n = isNumber(stored) ? stored : 0;
    if (
      request.method === "GET" &&
      new URL(request.url).searchParams.get("read") === "1"
    ) {
      return Response.json({ n });
    }
    await this.state.storage.put("n", n + 1);
    return Response.json({ n: n + 1, url: request.url } satisfies CounterBody);
  }
}

export default {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- test double mirrors the worker env contract.
  fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    // The namespace is the COUNTER binding this fixture is registered under.
    // SAFETY: the test harness registers COUNTER as a Durable Object namespace binding.
    const namespace = env["COUNTER"] as PoderDurableObjectNamespace;
    const url = new URL(request.url);
    const name = url.searchParams.get("name") ?? "default";
    // SAFETY: namespace stubs always expose fetch; getByName returns the object stub.
    const stub = namespace.getByName(name) as {
      fetch: (request: Request) => Promise<Response>;
    };
    return stub.fetch(request);
  },
};
