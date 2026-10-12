/** What the Preview panel's address bar may navigate its frame to: only the
 * running preview's own origin. A path (`/api`, `?q=1`) is read against the
 * preview's URL; a full URL must name that same origin. Anything else — another
 * host, another port, another scheme, the control UI's own origin — is refused,
 * so the bar can never point the frame (which runs unsandboxed, see the panel)
 * at a page it was not built for. */
export const previewAddress = (input: string, base: string): string | null => {
  const text = input.trim();
  if (text === "" || base === "") {
    return null;
  }
  let target: URL;
  let origin: string;
  try {
    target = new URL(text, base);
    ({ origin } = new URL(base));
  } catch {
    return null;
  }
  return target.origin === origin ? target.href : null;
};
