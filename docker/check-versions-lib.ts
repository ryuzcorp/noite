/**
 * celld pin validation for `check-versions.ts` (the gate).
 *
 * celld comes from the ryuzcorp/celld fork (SPEC.md `celld`): upstream
 * denoland/celld at a pinned release plus the fork's patches, published as
 * `<semver>-ryuzcorp.<n>` and pinned by digest in docker/Dockerfile. Tags
 * predating the fork carry the legacy `<semver>-noite.<n>` name: accepted
 * until the repin lands, but a release build refuses them, so an alpha can
 * never ship a pre-fork image.
 */

export type CelldFlavor = "ryuzcorp" | "noite";

export interface CelldTag {
  flavor: CelldFlavor;
  level: number;
  version: string;
}

export interface CelldPinReport {
  errors: string[];
  notes: string[];
}

const CELLD_TAG =
  /^(?<version>\d+\.\d+\.\d+)-(?<flavor>ryuzcorp|noite)\.(?<level>\d+)$/u;

/** Parse a CELLD_VERSION value into its parts, or null when malformed. */
export const parseCelldTag = (tag: string): CelldTag | null => {
  const groups = CELLD_TAG.exec(tag)?.groups;
  const flavor = groups?.flavor;

  if (
    groups?.version === undefined ||
    (flavor !== "ryuzcorp" && flavor !== "noite") ||
    groups.level === undefined
  ) {
    return null;
  }

  return { flavor, level: Number(groups.level), version: groups.version };
};

/**
 * Validate a CELLD_VERSION pin: it must name a fork tag, and a release
 * build refuses the legacy `-noite.` form. Errors fail the gate; notes are
 * informational. Pure (takes the tag), so tests pin it.
 */
export const checkCelldPin = (
  tag: string | undefined,
  release: boolean
): CelldPinReport => {
  const parsed = tag === undefined ? null : parseCelldTag(tag);

  if (!parsed) {
    return {
      errors: [
        `celld: docker/Dockerfile pins ${tag ?? "nothing"}, want <semver>-ryuzcorp.<n> (legacy <semver>-noite.<n> until the repin)`,
      ],
      notes: [],
    };
  }

  if (parsed.flavor === "noite") {
    if (release) {
      return {
        errors: [
          `celld: docker/Dockerfile pins legacy pre-fork tag ${tag}; a release must pin <semver>-ryuzcorp.<n>`,
        ],
        notes: [],
      };
    }

    return {
      errors: [],
      notes: [
        `celld: ${tag} is a legacy pre-fork pin; repin to the -ryuzcorp.<n> tag once published`,
      ],
    };
  }

  return { errors: [], notes: [] };
};
