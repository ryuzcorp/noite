import { Link, useRouter } from "@ilha/void";
import * as Atom from "effect/reactivity/Atom";
import { atom, watch } from "ilha";
import type { AtomHandle } from "ilha";

import { api } from "../api";
import type { PrCreateInput } from "../api-types";
import { errorMessage } from "../errors";
import { RefField } from "../forge/branches";
import { forgeCompare, forgeRefs } from "../forge/data";
import { resourceValue } from "../resource";
/** New-pull-request form: base/head branch pickers (from `gitRefs`), title
 * and body; it explains why Create is off and lands on the detail page on
 * success. */
import type { ResourceState } from "../resource";
import type { GitCompare, PrDetail } from "../runner";
import { Info } from "../ui/icons";
import { createInputOf, reasonText, validateNewPr } from "./new-pr";
import type { CompareStatus, NewPrInput } from "./new-pr";
import { invalidatePr, prList } from "./resources";

/** Run the one validation rule set. The form lists `validateNewPr` and the
 * submit guard uses `createInputOf` on the same input, so they cannot
 * disagree (the old pair let a duplicate base/head pair disable the button
 * while the submit guard still posted). */
const check = (input: NewPrInput) => {
  const reasons = validateNewPr(input);

  return {
    message: reasons.length === 0 ? null : reasonText(reasons[0]),
    reasons: reasons.map((reason) => reasonText(reason)),
    valid: reasons.length === 0,
  };
};

/** Create the pull request and land on its page. Only a valid form can build
 * a request body, so an invalid submit posts nothing. */
const submitNewPr = async ({
  appId,
  busy,
  input,
  notice,
  visit,
}: {
  appId: string;
  busy: AtomHandle<boolean>;
  input: NewPrInput & { readonly body: string };
  notice: AtomHandle<string>;
  visit: (to: string) => void;
}): Promise<void> => {
  const body = createInputOf(input);

  if (body === null) {
    notice.set(check(input).message ?? "This pull request cannot be created");

    return;
  }

  busy.set(true);
  notice.set("");

  try {
    const args: PrCreateInput = { appId, ...body };
    const detail = await api<PrDetail>("/api/prs/prsCreate", args);
    invalidatePr(appId);
    visit(`/apps/${appId}/pulls/${detail.pullRequest.number}`);
  } catch (error) {
    busy.set(false);
    notice.set(errorMessage(error));
  }
};

/** The compare a resource state represents, or null when no compare runs. */
const compareStatusOf = (
  state: ResourceState<GitCompare> | null
): CompareStatus | null => {
  if (state === null) {
    return null;
  }

  switch (state._tag) {
    case "Loading": {
      return { kind: "loading" };
    }

    case "Failed": {
      return { kind: "failed" };
    }

    default: {
      return { ahead: state.value.ahead, kind: "ready" };
    }
  }
};

/** The `N commits ahead · M files changed · mergeable` line. */
const CompareSummary = ({ compare }: { compare: GitCompare }) => (
  <p class="text-base-content/70 m-0 text-sm">
    {compare.ahead} commit{compare.ahead === 1 ? "" : "s"} ahead ·{" "}
    {compare.files.length} file{compare.files.length === 1 ? "" : "s"} changed
    {compare.mergeable ? " · mergeable" : " · conflicts"}
  </p>
);

/** The unmet preconditions listed above the Create button: the reasons the
 * primary action is off, in a box of their own — as bare grey lines they read
 * as helper text and "Add a title" looked like prose. */
const ReasonList = ({ reasons }: { reasons: readonly string[] }) => (
  <div class="border-base-300 bg-base-200/60 rounded-box flex flex-col gap-1.5 border p-3">
    <p class="m-0 flex items-center gap-1.5 text-sm font-medium">
      <Info class="h-4 w-4 shrink-0 opacity-70" />
      Before this pull request can be created
    </p>
    <ul class="text-base-content/70 m-0 flex list-disc flex-col gap-1 pl-5 text-sm">
      {reasons.map((reason) => (
        <li key={reason}>{reason}</li>
      ))}
    </ul>
  </div>
);

/** The compare of the picked pair, and the one line it prints. It owns the
 * resource for two reasons ilha forces: an atom is keyed by its allocation
 * order inside the enclosing fiber's render, and a tracked resource reuses its
 * atom for the lifetime of that render. Allocated in the form (only once the
 * picks are a real pair) it landed in the atom the pull-request list had
 * filled in the previous render — the summary then read `files` off that
 * payload and the page crashed; allocated there once, it kept the first pair's
 * answer forever. In its own fiber, keyed by the pair, every pair gets its own
 * resource, and the form's own allocation sequence never changes. The status
 * travels up for `validateNewPr`. */
const CompareLine = ({
  appId,
  base,
  head,
  onStatus,
}: {
  appId: string;
  base: string;
  head: string;
  onStatus: (status: CompareStatus) => void;
}) => {
  const res = forgeCompare(appId, base, head);
  const state = res.state();
  const status = compareStatusOf(state);
  // Two projections, because neither alone sees every settle: the value
  // keeps its reference through a cold Loading → Failed and a warm
  // Reloading → Failed (the form would stay "Comparing…"), and the tag stays
  // `Ready` when a reload lands a new payload.
  const tag = atom(Atom.readable((get) => get(res.state.atom)._tag));

  const report = (): undefined => {
    onStatus(compareStatusOf(res.state()) ?? { kind: "loading" });
  };

  watch(tag, report);
  watch(res.value, report);
  watch.once(report);

  return status?.kind === "ready" && state._tag === "Ready" ? (
    <CompareSummary compare={state.value} />
  ) : null;
};

/** The base ← head pickers, with a hint until the branch list arrives. */
const BranchPickers = ({
  appId,
  baseValue,
  headValue,
  loading,
  onBaseChange,
  onHeadChange,
}: {
  appId: string;
  baseValue: string;
  headValue: string;
  loading: boolean;
  onBaseChange: (next: string) => void;
  onHeadChange: (next: string) => void;
}) => (
  <div class="flex flex-wrap items-end gap-x-3 gap-y-2">
    <RefField
      appId={appId}
      caption="Base"
      value={baseValue}
      onChange={onBaseChange}
    />
    {/* Between the two, and only while they sit on one row: wrapped onto its
     * own line the arrow would read as "main ←". */}
    <span aria-hidden="true" class="hidden pb-2 opacity-50 sm:inline">
      ←
    </span>
    <RefField
      appId={appId}
      caption="Head"
      value={headValue}
      onChange={onHeadChange}
    />
    {loading ? (
      <span class="text-base-content/60 pb-2 text-xs">Loading branches…</span>
    ) : null}
  </div>
);

/** The footer: links to the open pull or to branch creation, then Create. */
const FormFooter = ({
  appId,
  busy,
  existingNumber,
  loading,
  otherBranchCount,
  valid,
}: {
  appId: string;
  busy: () => boolean;
  existingNumber: number | undefined;
  loading: boolean;
  otherBranchCount: number;
  valid: boolean;
}) => (
  <div class="flex items-center justify-end gap-3">
    {existingNumber === undefined ? null : (
      <Link
        class="link link-hover text-sm"
        href={`/apps/${appId}/pulls/${existingNumber}`}
      >
        View the open pull request →
      </Link>
    )}
    {loading || otherBranchCount > 0 ? null : (
      <Link class="link link-hover text-sm" href={`/apps/${appId}/source`}>
        Create a branch in Code mode →
      </Link>
    )}
    <button
      type="submit"
      class="btn btn-sm btn-neutral"
      disabled={busy() || !valid || loading}
    >
      {busy() ? "Creating…" : "Create pull request"}
    </button>
  </div>
);

export const NewPrForm = ({
  appId,
  baseDefault,
  headDefault,
  titleDefault,
}: {
  appId: string;
  baseDefault: string;
  headDefault: string;
  titleDefault: string;
}) => {
  const router = useRouter();
  const base = atom(baseDefault);
  const head = atom(headDefault);
  const title = atom(titleDefault);
  const body = atom("");
  const busy = atom(false);
  const notice = atom("");
  const refs = resourceValue(forgeRefs(appId).state());
  const branchNames = refs?.branches.map((branch) => branch.name) ?? [];
  const baseValue = base() || "main";

  const headValue =
    head() === ""
      ? (branchNames.find((name) => name !== baseValue) ?? "")
      : head();

  const otherBranches = branchNames.filter((name) => name !== baseValue);

  const picksDiffer =
    baseValue.trim() !== "" &&
    headValue.trim() !== "" &&
    baseValue.trim() !== headValue.trim();

  // Cheap: the compare runs only once both picks are real, distinct branches.
  // Reported by `CompareLine` (see its docs for why it owns the resource); a
  // new pair clears it before the next pair's compare runs.
  const compareStatus = atom<CompareStatus | null>(null);

  watch(base, () => {
    compareStatus.set(null);
  });
  watch(head, () => {
    compareStatus.set(null);
  });
  const compare = compareStatus();

  const openPulls =
    resourceValue(prList(appId, "open").state())?.pullRequests ?? [];

  const existing = openPulls.find(
    (pull) => pull.base === baseValue.trim() && pull.head === headValue.trim()
  );

  const input: NewPrInput = {
    base: baseValue.trim(),
    branchNames: refs === undefined ? undefined : branchNames,
    compare,
    existingNumber: existing?.number,
    head: headValue.trim(),
    title: title().trim(),
  };

  const result = check(input);
  const loading = refs === undefined;

  return (
    <form
      class="flex flex-col gap-4"
      onsubmit={(event) => {
        event.preventDefault();
        void submitNewPr({
          appId,
          busy,
          input: {
            base: baseValue.trim(),
            body: body(),
            branchNames: refs === undefined ? undefined : branchNames,
            compare,
            existingNumber: existing?.number,
            head: headValue.trim(),
            title: title().trim(),
          },
          notice,
          visit: (to) => router.visit(to),
        });
      }}
    >
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}

      <BranchPickers
        appId={appId}
        baseValue={baseValue}
        headValue={headValue}
        loading={refs === undefined}
        onBaseChange={(next) => {
          base.set(next);
        }}
        onHeadChange={(next) => {
          head.set(next);
        }}
      />

      {picksDiffer ? (
        <CompareLine
          key={`${baseValue.trim()}:${headValue.trim()}`}
          appId={appId}
          base={baseValue.trim()}
          head={headValue.trim()}
          onStatus={(next) => {
            compareStatus.set(next);
          }}
        />
      ) : null}

      <fieldset class="fieldset">
        <label class="label" for="pr-title">
          Title
        </label>
        <input
          id="pr-title"
          name="title"
          class="input w-full"
          placeholder="Short summary of the changes"
          value={title()}
          oninput={(event) => {
            title.set(event.currentTarget.value);
          }}
          required
        />
      </fieldset>

      <fieldset class="fieldset">
        <label class="label" for="pr-body">
          Description
        </label>
        <textarea
          id="pr-body"
          name="body"
          class="textarea w-full"
          rows={6}
          placeholder="What changed and why (optional)"
          value={body()}
          oninput={(event) => {
            body.set(event.currentTarget.value);
          }}
        />
      </fieldset>

      {result.reasons.length > 0 ? (
        <ReasonList reasons={result.reasons} />
      ) : null}

      <FormFooter
        appId={appId}
        busy={busy}
        existingNumber={existing?.number}
        loading={loading}
        otherBranchCount={otherBranches.length}
        valid={result.valid}
      />
    </form>
  );
};
