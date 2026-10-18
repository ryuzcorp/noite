import { atom } from "ilha";
import type { AtomHandle } from "ilha";

import { errorMessage } from "../errors";
import { RefSelect } from "../forge/branches";
import { forgeCompare, forgeRefs } from "../forge/data";
/** New-pull-request form: base/head branch pickers (from `gitRefs`), title
 * and body; it explains why Create is off and lands on the detail page on
 * success. */
import { navigate } from "../navigation";
import type { GitCompare } from "../runner";
import { prsCreate } from "../server/prs.server";
import type { PrCreateInput } from "../server/prs.server";
import { invalidatePr, prList } from "./resources";

/** The reasons Create is off, in the order the form reads them. Passed
 * trimmed values so this list and the submit guard agree. */
const newPrBlockers = ({
  ahead,
  base,
  existingNumber,
  head,
  loading,
  otherBranchCount,
  title,
}: {
  ahead: number | undefined;
  base: string;
  existingNumber: number | undefined;
  head: string;
  loading: boolean;
  otherBranchCount: number;
  title: string;
}): string[] => {
  const reasons: string[] = [];
  if (!loading) {
    if (otherBranchCount === 0) {
      reasons.push("Create a branch first");
    }
    if (base === "" || head === "") {
      reasons.push("Pick both a base and a head branch");
    } else if (base === head) {
      reasons.push("Head must differ from base");
    }
    if (existingNumber !== undefined) {
      reasons.push(
        `A pull request for this pair is already open (#${existingNumber})`
      );
    }
    if (ahead === 0) {
      reasons.push(`No commits on ${head} over ${base}`);
    }
  }
  if (title === "") {
    reasons.push("Add a title");
  }
  return reasons;
};

/** The first reason Create can't run, phrased for the alert the form shows. */
const newPrProblem = ({
  ahead,
  base,
  head,
  title,
}: {
  ahead: number | undefined;
  base: string;
  head: string;
  title: string;
}): string | null => {
  if (title === "") {
    return "Title is required";
  }
  if (base === "" || head === "") {
    return "Pick both a base and a head branch";
  }
  if (base === head) {
    return "Head must differ from base";
  }
  if (ahead === 0) {
    return `No commits on ${head} over ${base}; push a commit first`;
  }
  return null;
};

/** Create the pull request and land on its page, or show the first unmet
 * precondition. */
const submitNewPr = async ({
  appId,
  base,
  body,
  busy,
  head,
  notice,
  problem,
  title,
}: {
  appId: string;
  base: string;
  body: string;
  busy: AtomHandle<boolean>;
  head: string;
  notice: AtomHandle<string>;
  problem: string | null;
  title: string;
}): Promise<void> => {
  if (problem !== null) {
    notice.set(problem);
    return;
  }
  busy.set(true);
  notice.set("");
  try {
    const args: PrCreateInput = { appId, base, head, title };
    if (body !== "") {
      args.body = body;
    }
    const detail = await prsCreate(args);
    invalidatePr(appId);
    navigate(`/apps/${appId}/pulls/${detail.pullRequest.number}`);
  } catch (error) {
    busy.set(false);
    notice.set(errorMessage(error));
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

/** The unmet preconditions listed above the Create button. */
const ReasonList = ({ reasons }: { reasons: readonly string[] }) => (
  <ul class="text-base-content/70 m-0 flex list-none flex-col gap-1 p-0 text-sm">
    {reasons.map((reason) => (
      <li key={reason}>{reason}</li>
    ))}
  </ul>
);

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
  <div class="flex flex-wrap items-center gap-2">
    <RefSelect
      appId={appId}
      label="Base branch"
      value={baseValue}
      onChange={onBaseChange}
    />
    <span aria-hidden="true" class="opacity-50">
      ←
    </span>
    <RefSelect
      appId={appId}
      label="Head branch"
      value={headValue}
      onChange={onHeadChange}
    />
    {loading ? (
      <span class="text-base-content/60 text-xs">Loading branches…</span>
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
      <a
        class="link link-hover text-sm"
        href={`/apps/${appId}/pulls/${existingNumber}`}
      >
        View the open pull request →
      </a>
    )}
    {loading || otherBranchCount > 0 ? null : (
      <a class="link link-hover text-sm" href={`/apps/${appId}/source`}>
        Create a branch in Code mode →
      </a>
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
  const base = atom(baseDefault);
  const head = atom(headDefault);
  const title = atom(titleDefault);
  const body = atom("");
  const busy = atom(false);
  const notice = atom("");
  const refs = forgeRefs(appId).data();
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
  const compare = picksDiffer
    ? forgeCompare(appId, baseValue.trim(), headValue.trim()).data()
    : undefined;
  const openPulls = prList(appId, "open").data()?.pullRequests ?? [];
  const existing = openPulls.find(
    (pull) => pull.base === baseValue.trim() && pull.head === headValue.trim()
  );
  const loading = refs === undefined;

  const reasons = newPrBlockers({
    ahead: compare?.ahead,
    base: baseValue.trim(),
    existingNumber: existing?.number,
    head: headValue.trim(),
    loading,
    otherBranchCount: otherBranches.length,
    title: title().trim(),
  });

  const valid = reasons.length === 0;

  return (
    <form
      class="flex flex-col gap-4"
      onsubmit={(event) => {
        event.preventDefault();
        const nextBase = baseValue.trim();
        const nextHead = headValue.trim();
        const nextTitle = title().trim();
        void submitNewPr({
          appId,
          base: nextBase,
          body: body().trim(),
          busy,
          head: nextHead,
          notice,
          problem: newPrProblem({
            ahead: compare?.ahead,
            base: nextBase,
            head: nextHead,
            title: nextTitle,
          }),
          title: nextTitle,
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

      {compare === undefined ? null : <CompareSummary compare={compare} />}

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

      {reasons.length > 0 ? <ReasonList reasons={reasons} /> : null}

      <FormFooter
        appId={appId}
        busy={busy}
        existingNumber={existing?.number}
        loading={loading}
        otherBranchCount={otherBranches.length}
        valid={valid}
      />
    </form>
  );
};
