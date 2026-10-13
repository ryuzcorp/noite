/** New-pull-request form: base/head branch pickers (from `gitRefs`), title
 * and body; on success it lands on the detail page. */
import { navigate } from "@ilha/router";
import { atom } from "ilha";

import { errorMessage } from "../errors";
import { RefSelect } from "../forge/branches";
import { forgeRefs } from "../forge/data";
import { prsCreate } from "../server/prs.server";
import type { PrCreateInput } from "../server/prs.server";
import { invalidatePr } from "./resources";

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

  const submit = async (): Promise<void> => {
    const nextBase = baseValue.trim();
    const nextHead = headValue.trim();
    const nextTitle = title().trim();
    if (nextTitle === "") {
      notice.set("Title is required");
      return;
    }
    if (nextBase === "" || nextHead === "") {
      notice.set("Pick both a base and a head branch");
      return;
    }
    if (nextBase === nextHead) {
      notice.set("Head must differ from base");
      return;
    }
    busy.set(true);
    notice.set("");
    try {
      const args: PrCreateInput = {
        appId,
        base: nextBase,
        head: nextHead,
        title: nextTitle,
      };
      const description = body().trim();
      if (description !== "") {
        args.body = description;
      }
      const detail = await prsCreate(args);
      invalidatePr(appId);
      navigate(`/apps/${appId}/pulls/${detail.pullRequest.number}`);
    } catch (error) {
      busy.set(false);
      notice.set(errorMessage(error));
    }
  };

  const valid =
    title().trim() !== "" &&
    baseValue.trim() !== "" &&
    headValue.trim() !== "" &&
    baseValue.trim() !== headValue.trim();

  return (
    <form
      class="flex flex-col gap-4"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {notice() ? (
        <div class="alert alert-error m-0 py-2" role="alert">
          <span>{notice()}</span>
        </div>
      ) : null}

      <div class="flex flex-wrap items-center gap-2">
        <RefSelect
          appId={appId}
          label="Base branch"
          value={baseValue}
          onChange={(next) => {
            base.set(next);
          }}
        />
        <span aria-hidden="true" class="opacity-50">
          ←
        </span>
        <RefSelect
          appId={appId}
          label="Head branch"
          value={headValue}
          onChange={(next) => {
            head.set(next);
          }}
        />
        {refs === undefined ? (
          <span class="text-base-content/60 text-xs">Loading branches…</span>
        ) : null}
      </div>

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

      <div class="flex justify-end">
        <button
          type="submit"
          class="btn btn-sm btn-neutral"
          disabled={busy() || !valid}
        >
          {busy() ? "Creating…" : "Create pull"}
        </button>
      </div>
    </form>
  );
};
