/**
 * Joining a flow's JSON to its typed rules.
 *
 * Each flow keeps the portal's wording, its layout and the placements in a
 * JSON file a person can check against captures of the portal, and the rules
 * each field enforces in TypeScript beside it. These join the two, so every
 * flow is built the same way.
 *
 * Pure. Safe from the browser entry.
 */

import type {
  DirectoryCheckNeed,
  DirectoryCheckPlacement,
  DirectoryFlowField,
  DirectoryFlowOption,
  DirectoryPortalErrorCode,
} from "./types.js";

/** What a flow's JSON says about a field. */
export interface DirectoryFieldWords {
  label: string;
  reviewLabel?: string;
  placeholder?: string;
  helper?: string;
  options?: DirectoryFlowOption[];
  errors?: Partial<Record<DirectoryPortalErrorCode, string>>;
  packagePath?: string;
}

/** Everything about a field that is not in its JSON. */
export type DirectoryFieldRules = Omit<
  DirectoryFlowField,
  "key" | keyof DirectoryFieldWords
>;

/** One row of a flow's JSON placements: several checks in one place. */
export interface DirectoryPlacementEntry {
  step: string;
  field?: string;
  reads: string[];
  needs: string[];
  checks: string[];
}

const NEEDS: readonly DirectoryCheckNeed[] = [
  "server",
  "reviewer",
  "model",
  "package",
];

/** The fields of `step`, in rule order. A field's step is its key's prefix. */
export function stepFields<Key extends string>(
  step: string,
  rules: Record<Key, DirectoryFieldRules>,
  words: Record<Key, DirectoryFieldWords>
): DirectoryFlowField[] {
  return (Object.keys(rules) as Key[])
    .filter((key) => key.startsWith(`${step}.`))
    .map((key) => ({
      key,
      ...words[key],
      ...rules[key],
      errors: words[key].errors ?? {},
    }));
}

/** One placement per check, refusing a need the model does not have. */
export function placementsFrom(
  file: string,
  entries: readonly DirectoryPlacementEntry[]
): DirectoryCheckPlacement[] {
  return entries.flatMap(({ checks, needs, ...where }) =>
    checks.map((checkId) => ({
      checkId,
      ...where,
      needs: needs.map((name) => {
        const known = NEEDS.find((entry) => entry === name);
        if (!known) throw new Error(`${file} names an unknown need: ${name}`);
        return known;
      }),
    }))
  );
}
