/** Response for a hand-rolled SSE stream. */
export const sseResponse = (stream: ReadableStream): Response => {
  const headers = new Headers();
  headers.set("content-type", "text/event-stream");
  headers.set("cache-control", "no-cache");
  headers.set("connection", "keep-alive");
  return new Response(stream, { headers });
};

/** Sleep `ms`, waking early when `signal` aborts. The abort listener is
 * removed on every exit path: a long-lived stream sleeps once per cycle, and
 * a listener left behind each time would pile up on `request.signal` for as
 * long as the tab stays open. */
export const sleepUnlessAborted = (
  ms: number,
  signal: AbortSignal
): Promise<void> =>
  // oxlint-disable-next-line promise/avoid-new -- abortable sleep; Effect.sleep takes no abort signal
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const wake = () => {
      // oxlint-disable-next-line eslint/no-use-before-define -- the timer and the abort listener each cancel the other
      clearTimeout(timer);
      signal.removeEventListener("abort", wake);
      resolve();
    };
    const timer = setTimeout(wake, ms);
    signal.addEventListener("abort", wake, { once: true });
  });

/** Close a stream controller the client may already have cancelled. */
export const closeQuietly = (
  controller: ReadableStreamDefaultController
): void => {
  try {
    controller.close();
  } catch {
    // Already closed by the client going away.
  }
};
