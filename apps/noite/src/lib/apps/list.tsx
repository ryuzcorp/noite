//! The apps list (live over SSE), the pending-invitations banner and the
//! control-plane card above it. The create form lives in ./create-form.

import { Link, useRouter } from "@ilha/void";
import { Data } from "effect";
import { atom } from "ilha";

import { api } from "../api";
import type { App } from "../collaborators";
import {
  CONTROL_APP_ID,
  CONTROL_APP_NAME,
  CONTROL_APP_SUBTITLE,
} from "../control-app";
import { errorMessage } from "../errors";
import {
  applistUrl,
  decodeApps,
  feedKeys,
  feedLoaded,
  feedLoading,
  feedProblem,
  feedRetrying,
  feedValue,
  liveFeed,
} from "../feeds";
import { resourceValue } from "../resource";
import {
  adminStatus,
  invalidate,
  keys,
  myInvitations,
  session,
} from "../resources";
import { Avatar } from "../ui/avatar";
import { ChevronRight } from "../ui/icons";
import { ListSkeleton } from "../ui/skeletons";
import { appUrl, presenceTone } from "./identity";

/** One invitation's answer. `Failed` names the invitation it is about, so the
 * error sits on the row that produced it instead of under the whole banner. */
export type InviteAction = Data.TaggedEnum<{
  Answering: { accept: boolean; id: string };
  Failed: { error: string; id: string };
  Idle: Record<never, never>;
}>;

export const Invite = Data.taggedEnum<InviteAction>();

export type InviteMessage = Data.TaggedEnum<{
  Answered: Record<never, never>;
  Answering: { accept: boolean; id: string };
  Failed: { error: string; id: string };
}>;

const InviteMsg = Data.taggedEnum<InviteMessage>();

/** The banner's whole machine: `Idle → Answering → Idle` (answered) or
 * `Failed`; a new answer clears the last error. One answer at a time, because
 * an accept navigates away and two in flight would race the visit. */
export const answerInvite = (
  state: InviteAction,
  message: InviteMessage
): InviteAction =>
  InviteMsg.$match(message, {
    Answered: () => Invite.Idle(),
    Answering: (started) =>
      Invite.Answering({ accept: started.accept, id: started.id }),
    Failed: (failed) => Invite.Failed({ error: failed.error, id: failed.id }),
  });

/** Collaborator invitations addressed to this account's email: nothing is
 * granted until the person accepts here. Renders nothing when there are none. */
const InvitationsBanner = () => {
  const router = useRouter();
  const res = myInvitations();
  const action = atom<InviteAction>(Invite.Idle());
  const invites = resourceValue(res.state()) ?? [];

  if (invites.length === 0 && action()._tag !== "Failed") {
    return null;
  }

  const answer = async (inviteId: string, accept: boolean) => {
    action.set(
      answerInvite(action(), InviteMsg.Answering({ accept, id: inviteId }))
    );

    try {
      if (accept) {
        const { appId } = await api<{ appId: string }>(
          "/api/collaborators/acceptInvitation",
          inviteId
        );

        invalidate(keys.myInvitations);
        router.visit(`/apps/${appId}`);

        return;
      }

      await api<{ ok: true }>("/api/collaborators/declineInvitation", inviteId);
      invalidate(keys.myInvitations);
      action.set(answerInvite(action(), InviteMsg.Answered()));
    } catch (error) {
      action.set(
        answerInvite(
          action(),
          InviteMsg.Failed({ error: errorMessage(error), id: inviteId })
        )
      );
      invalidate(keys.myInvitations);
    }
  };

  const current = action();

  return (
    <section
      class="card bg-base-100 dark:bg-base-200 border-base-300 w-full border shadow-md"
      aria-label="Invitations"
    >
      <div class="card-body gap-2 p-4">
        <h2 class="m-0 text-lg font-semibold">Invitations</h2>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          {invites.map((invite) => {
            const mine =
              current._tag === "Answering" && current.id === invite.id
                ? current
                : null;

            const error =
              current._tag === "Failed" && current.id === invite.id
                ? current.error
                : "";

            return (
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
                    disabled={current._tag === "Answering"}
                    onclick={() => {
                      void answer(invite.id, true);
                    }}
                  >
                    {mine?.accept === true ? "Accepting…" : "Accept"}
                  </button>
                  <button
                    type="button"
                    class="btn btn-sm btn-ghost"
                    disabled={current._tag === "Answering"}
                    onclick={() => {
                      void answer(invite.id, false);
                    }}
                  >
                    {mine?.accept === false ? "Declining…" : "Decline"}
                  </button>
                </span>
                {error ? (
                  <span class="text-error m-0 w-full text-sm">{error}</span>
                ) : null}
              </li>
            );
          })}
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
        <Link
          href={`/apps/${CONTROL_APP_ID}`}
          class="link link-hover block truncate text-lg font-semibold"
        >
          {CONTROL_APP_NAME}
        </Link>
      </div>
      <div class="text-base-content/70 truncate text-xs">
        {CONTROL_APP_SUBTITLE}
      </div>
    </div>
    <Link
      href={`/apps/${CONTROL_APP_ID}`}
      class="btn btn-sm btn-square btn-ghost shrink-0"
      aria-label={`Open ${CONTROL_APP_NAME}`}
    >
      <span class="inline-flex h-5 w-5 shrink-0">
        <ChevronRight class="h-5 w-5" />
      </span>
    </Link>
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
    const user = resourceValue(sess.state());

    if (!user || user.session.impersonatedBy !== null) {
      return false;
    }

    return resourceValue(admin.state())?.isAdmin ?? false;
  };

  const items = (): App[] => feedValue(feed.state()) ?? [];

  const loaded = (): boolean => feedLoaded(feed.state());

  const retrying = (): boolean => feedRetrying(feed.state());

  const problem = (): string | null => feedProblem(feed.state());

  return (
    <>
      <InvitationsBanner />
      {retrying() ? (
        <p class="text-error m-0 text-sm">
          App stream disconnected — retrying…
        </p>
      ) : null}
      {problem() ? <p class="text-error m-0 text-sm">{problem()}</p> : null}

      <ul class="list bg-base-100 dark:bg-base-200 border-base-300 rounded-box w-full border shadow-md">
        <li class="flex items-center justify-between gap-2 p-4 pb-2">
          <span class="flex items-center gap-2 tracking-wide">
            <span class="text-lg font-semibold">Your Apps</span>
            <span class="badge badge-sm">{items().length}</span>
          </span>
          <Link href="/apps/new" class="btn btn-sm btn-neutral">
            New app
          </Link>
        </li>
        {showControl() ? <ControlAppRow /> : null}
        {feedLoading(feed.state()) ? (
          <li class="px-4 pt-2 pb-4">
            <ListSkeleton rows={3} />
          </li>
        ) : null}
        {loaded() && items().length === 0 && (
          <li class="px-4 pt-2 pb-4 text-sm">
            <span class="text-base-content/70">No apps yet. </span>
            <Link href="/apps/new" class="link">
              Create one
            </Link>
            <span class="text-base-content/70"> to get a git remote.</span>
          </li>
        )}
        {loaded() &&
          items().map((app) => (
            <li key={app.id} class="list-row">
              <div>
                <Avatar
                  label={app.name}
                  status={
                    app.fleetHold ? `${app.status} (retrying)` : app.status
                  }
                  tone={presenceTone(
                    app.status,
                    app.desiredState,
                    app.fleetHold
                  )}
                />
              </div>
              <div>
                <div>
                  <Link
                    href={`/apps/${app.id}`}
                    class="link link-hover block truncate text-lg font-semibold"
                  >
                    {app.name}
                  </Link>
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
              <Link
                href={`/apps/${app.id}`}
                class="btn btn-sm btn-square btn-ghost shrink-0"
                aria-label={`Open ${app.name} details`}
              >
                <span class="inline-flex h-5 w-5 shrink-0">
                  <ChevronRight class="h-5 w-5" />
                </span>
              </Link>
            </li>
          ))}
      </ul>
    </>
  );
};
