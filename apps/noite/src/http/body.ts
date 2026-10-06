/** Largest JSON body the machine routes (`/webhook`, ingest) will read.
 * Events, identifies and insights are a few hundred bytes; this only bounds
 * what one caller can make the worker buffer. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Read a request body as text, refusing (null) anything over `max` bytes —
 * by the declared length first, then by counting what actually arrives so a
 * missing or lying `content-length` cannot slip past. */
export const readBoundedText = async (
  request: Request,
  max: number
): Promise<string | null> => {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    return null;
  }
  if (!request.body) {
    return "";
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- chunks must be counted in arrival order
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    received += value.byteLength;
    if (received > max) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- stop the upload as soon as it is over the bound
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
};

export const tooLarge = (): Response =>
  new Response("request body too large", { status: 413 });
