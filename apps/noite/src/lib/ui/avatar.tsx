//! One avatar placeholder: initials on a neutral disc, plus an optional
//! presence dot. The nav, the app lists, the admin rows and the app header
//! all render this so the shape and tone stay in one place.

import { initials } from "../apps/identity";

const SIZES = {
  lg: { disc: "w-11", text: "" },
  md: { disc: "w-10", text: "text-sm" },
  sm: { disc: "w-8", text: "text-xs" },
} as const;

export type AvatarSize = keyof typeof SIZES;

export const Avatar = ({
  class: extra,
  label,
  size = "md",
  status,
  tone,
}: {
  class?: string;
  label: string;
  size?: AvatarSize;
  /** Tooltip for the presence dot; only rendered when `tone` is set. */
  status?: string;
  tone?: string;
}) => {
  const sizeClasses = SIZES[size];
  return (
    <div class={`avatar avatar-placeholder ${extra ?? ""}`.trim()}>
      <div
        class={`bg-neutral text-neutral-content ${sizeClasses.disc} rounded-full`}
      >
        <span class={sizeClasses.text}>{initials(label)}</span>
      </div>
      {tone ? (
        <span
          class={`status ${tone} absolute right-0 bottom-0`}
          title={status}
        />
      ) : null}
    </div>
  );
};
