//! Storage detail dispatch: D1 → the table editor, R2 → the object browser,
//! DO → the instance viewer. Each view owns its own chrome (breadcrumb,
//! toolbar, list, detail panel) — see ./d1/panel, ./r2/panel, ./do/panel.

import {
  CONTROL_APP_DATABASE_ID,
  CONTROL_APP_NAME,
  isControlApp,
} from "../control-app";
import { appDetail } from "../resources";
import { parseAppRole, roleAtLeast } from "../roles";
import { D1Editor } from "./d1/panel";
import { DoBrowser } from "./do/panel";
import { R2Browser } from "./r2/panel";

/** One storage resource's details, dispatched on the resource-id prefix. */
export const StorageDetail = ({
  appId,
  resourceId,
}: {
  appId: string;
  resourceId: string;
}) => {
  // The control app is not a runner app: its one resource is the control D1,
  // served in-process by the worker (never a runner lookup).
  if (isControlApp(appId)) {
    if (resourceId === `d1:${CONTROL_APP_DATABASE_ID}`) {
      return (
        <D1Editor
          appId={appId}
          appName={CONTROL_APP_NAME}
          databaseId={CONTROL_APP_DATABASE_ID}
        />
      );
    }
    return <p class="m-0 text-sm opacity-70">Unknown storage resource.</p>;
  }
  const detail = appDetail(appId);
  const appName = detail.data()?.app.name ?? "";
  // Writes (upload, New folder, delete) need the push role; a viewer still
  // browses, previews and downloads.
  const myRole = parseAppRole(detail.data()?.myRole ?? "") ?? "view";
  const canWrite = roleAtLeast(myRole, "push");
  if (resourceId.startsWith("r2:")) {
    return (
      <R2Browser
        appId={appId}
        appName={appName}
        bucket={resourceId.slice(3)}
        canWrite={canWrite}
      />
    );
  }
  if (resourceId.startsWith("d1:")) {
    return (
      <D1Editor
        appId={appId}
        appName={appName}
        databaseId={resourceId.slice(3)}
      />
    );
  }
  // DO resource ids are "do:{Binding}:{Name}" — the class is everything
  // after the binding, and either part may itself contain a colon.
  const className = resourceId.startsWith("do:")
    ? resourceId.split(":").slice(2).join(":")
    : resourceId;
  return <DoBrowser appId={appId} appName={appName} className={className} />;
};
