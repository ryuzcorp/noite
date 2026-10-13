import * as Schema from "effect/Schema";
import { action, useEnv, useRequest, withSchema } from "oxidejs";

import { requireAppRole } from "../collaborators";
import { isLocalhostDomain } from "../local-host";
import {
  PREVIEW_MIXED_CONTENT_MESSAGE,
  previewBase,
  previewOrigin,
} from "../preview-host";
import { AuthError, sessionUser } from "./session.server";

const PreviewOriginArgs = Schema.Struct({ appId: Schema.String });

/** The app's Preview origin, ready for `Nodepod.boot({ previewOrigin })`:
 * `app-0.preview.<slug>.<base>` (dev `http://…:port`), the one stable origin
 * the edge serves the four Nodepod assets from (never the control UI's, so
 * guest code can't act as the viewer). `<base>` follows the page onto a DNS
 * `CONTROL_EXTRA_HOSTS` entry (`previewBase`), so `https://noite.local` gets
 * `https://app-0.preview.<slug>.noite.local`. Refuses a secure page with a
 * plain http preview host (`PREVIEW_MIXED_CONTENT_MESSAGE`) instead of an
 * origin that cannot connect. */
export const sourcePreviewOrigin = action(
  withSchema(PreviewOriginArgs, async ({ appId }) => {
    const user = await sessionUser();
    const { app } = await requireAppRole(appId, user.id, "view");
    const env = useEnv<KitEnv>();
    const request = useRequest();
    const url = new URL(request.url);
    // Behind the edge the action sees the internal http URL: the page's real
    // scheme and host ride `X-Forwarded-Proto`/`X-Forwarded-Host`, which Caddy
    // sets.
    const scheme =
      request.headers.get("x-forwarded-proto") ??
      url.protocol.replace(/:$/u, "");
    const pageHost = request.headers.get("x-forwarded-host") ?? url.host;
    const base = previewBase(
      pageHost,
      env?.BASE_DOMAIN ?? "localhost",
      env?.CONTROL_EXTRA_HOSTS
    );
    const port = isLocalhostDomain(base) ? url.port : "";
    const origin = previewOrigin(app.slug, base, port);
    // Fail closed: a localhost preview host is plain http, which browsers
    // block inside a secure page as mixed content. The action surfaces the
    // message through `failUnknown`, and the panel shows it verbatim.
    if (scheme === "https" && origin.startsWith("http://")) {
      throw new Error(PREVIEW_MIXED_CONTENT_MESSAGE);
    }
    return { previewOrigin: origin };
  }),
  { error: AuthError }
);
