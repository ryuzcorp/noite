//! The apps list (live over SSE), the pending-invitations banner and the
//! control-plane card above it. The create form lives in ./create-form.

import { navigate } from "@ilha/router";
import { atom } from "ilha";

import type { App } from "../collaborators";
import {
  CONTROL_APP_ID,
  CONTROL_APP_NAME,
  CONTROL_APP_SUBTITLE,
} from "../control-app";
import { errorMessage } from "../errors";
import { applistUrl, decodeApps, feedKeys, liveFeed } from "../feeds";
import {
  adminStatus,
  invalidate,
  keys,
  myInvitations,
  session,
} from "../resources";
import {
  acceptInvitation,
  declineInvitation,
} from "../server/collaborators.server";
import { Avatar } from "../ui/avatar";
import { ChevronRight } from "../ui/icons";
import { ListSkeleton } from "../ui/skeletons";
import { appUrl, presenceTone } from "./identity";

/** Collaborator invitations addressed to this account's email: nothing is
 * granted until the person accepts here. Renders nothing when there are none. */
const InvitationsBanner = () => {
  const res = myInvitations();
  const busy = atom(false);
  const notice = atom("");
  const invites = res.data() ?? [];
  if (invites.length === 0 && !notice()) {
    return null;
  }
  const answer = async (inviteId: string, accept: boolean) => {
    busy.set(true);
    notice.set("");
    try {
      if (accept) {
        const { appId } = await acceptInvitation(inviteId);
        invalidate(keys.myInvitations);
        navigate(`/apps/${appId}`);
      } else {
        await declineInvitation(inviteId);
        invalidate(keys.myInvitations);
      }
    } catch (error) {
      notice.set(errorMessage(error));
      invalidate(keys.myInvitations);
    }
    busy.set(false);
  };
  return (
    <section
      class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md"
      aria-label="Invitations"
    >
      <div class="card-body gap-2 p-4">
        <h2 class="m-0 text-lg font-semibold">Invitations</h2>
        {notice() ? <p class="text-error m-0 text-sm">{notice()}</p> : null}
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          {invites.map((invite) => (
            <li
              key={invite.id}
              class="flex flex-wrap items-center justify-between gap-2 text-sm"
            >
              <span>
                Join <strong>{invite.appName}</strong> as{" "}
                <span class="badge badge-ghost badge-sm">{invite.role}</span>
              </span>
              <span class="flex gap-2">
                <button
                  type="button"
                  class="btn btn-sm btn-neutral"
                  disabled={busy()}
                  onclick={() => {
                    void answer(invite.id, true);
                  }}
                >
                  Accept
                </button>
                <button
                  type="button"
                  class="btn btn-sm btn-ghost"
                  disabled={busy()}
                  onclick={() => {
                    void answer(invite.id, false);
                  }}
                >
                  Decline
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};

/** The control plane as an extra card above the user's apps. Only a real
 * instance admin sees it, and never on an impersonated session — the same
 * gate every control-D1 action re-checks server-side. It links to the
 * dedicated control app detail, not a runner app row. */
const ControlAppRow = () => (
  <li class="list-row">
    <div>
      <Avatar
        label={CONTROL_APP_NAME}
        status="running"
        tone={presenceTone("running")}
      />
    </div>
    <div>
      <div>
        <a
          href={`/apps/${CONTROL_APP_ID}`}
          class="link link-hover block truncate text-lg font-semibold"
        >
          {CONTROL_APP_NAME}
        </a>
      </div>
      <div class="text-base-content/70 truncate text-xs">
        {CONTROL_APP_SUBTITLE}
      </div>
    </div>
    <a
      href={`/apps/${CONTROL_APP_ID}`}
      class="btn btn-sm btn-square btn-ghost shrink-0"
      aria-label={`Open ${CONTROL_APP_NAME}`}
    >
      <span class="inline-flex h-5 w-5 shrink-0">
        <ChevronRight class="h-5 w-5" />
      </span>
    </a>
  </li>
);

/** App list over SSE: skeleton until the first frame, then live updates —
 * no polling, and resubscribe is automatic on drop. */
export const AppsList = () => {
  const feed = liveFeed(feedKeys.apps, applistUrl(), decodeApps);
  // `session()` is shared with the layout; `adminStatus()` is one cached call.
  const admin = adminStatus();
  const sess = session();
  const showControl = (): boolean => {
    const user = sess.data();
    if (!user || user.session.impersonatedBy !== null) {
      return false;
    }
    return admin.data()?.isAdmin ?? false;
  };
  const items = (): App[] => feed.latest() ?? [];
  const loaded = (): boolean =>
    feed.latest() !== undefined || feed.status() === "open";
  const retrying = (): boolean => feed.status() === "retrying";

  return (
    <>
      <InvitationsBanner />
      {retrying() ? (
        <p class="text-error m-0 text-sm">
          App stream disconnected — retrying…
        </p>
      ) : null}

      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Your Apps</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
          <a href="/apps/new" class="btn btn-sm btn-neutral">
            New app
          </a>
        </li>
        {showControl() ? <ControlAppRow /> : null}
        {!loaded() && (
          <li class="px-4 pt-2 pb-4">
            <ListSkeleton rows={3} />
          </li>
        )}
        {loaded() && items().length === 0 && (
          <li class="px-4 pt-2 pb-4 text-sm">
            <span class="text-base-content/70">No apps yet. </span>
            <a href="/apps/new" class="link">
              Create one
            </a>
            <span class="text-base-content/70"> to get a git remote.</span>
          </li>
        )}
        {loaded() &&
          items().map((app) => (
            <li key={app.id} class="list-row">
              <div>
                <Avatar
                  label={app.name}
                  status={app.status}
                  tone={presenceTone(app.status)}
                />
              </div>
              <div>
                <div>
                  <a
                    href={`/apps/${app.id}`}
                    class="link link-hover block truncate text-lg font-semibold"
                  >
                    {app.name}
                  </a>
                </div>
                <div class="text-base-content/70 truncate text-xs">
                  <a
                    class="link"
                    href={appUrl(app.subdomain)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {app.subdomain}
                  </a>
                </div>
              </div>
              <a
                href={`/apps/${app.id}`}
                class="btn btn-sm btn-square btn-ghost shrink-0"
                aria-label={`Open ${app.name} details`}
              >
                <span class="inline-flex h-5 w-5 shrink-0">
                  <ChevronRight class="h-5 w-5" />
                </span>
              </a>
            </li>
          ))}
      </ul>
    </>
  );
};
