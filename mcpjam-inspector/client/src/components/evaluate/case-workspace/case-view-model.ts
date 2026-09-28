import {
  normalizeSteps,
  promptTurnsToSteps,
  resolvePromptTurnsWithLegacyProbe,
} from "@/shared/steps";
import type { CaseSnapshotFields } from "./case-snapshot-signature";
import { signaturesMatch } from "./case-snapshot-signature";

export type CaseViewSource = CaseSnapshotFields & {
  query?: string;
  promptTurns?: unknown[];
  expectedToolCalls?: unknown[];
};

/** Historical content is derived exclusively from the captured source. */
export function caseViewModel(
  mode: "draft" | "live" | "historical",
  source: CaseViewSource | null | undefined,
) {
  const native = Array.isArray(source?.steps);
  const legacy =
    !!source &&
    (typeof source.query === "string" || Array.isArray(source.promptTurns));
  const steps = native
    ? normalizeSteps(source!.steps!)
    : legacy
      ? promptTurnsToSteps(
          resolvePromptTurnsWithLegacyProbe(
            source as Parameters<typeof resolvePromptTurnsWithLegacyProbe>[0],
          ),
        )
      : [];
  return {
    mode,
    readOnly: mode !== "draft",
    steps,
    expectedOutput: source?.expectedOutput ?? undefined,
    matchOptions: source?.matchOptions ?? undefined,
    predicates: source?.predicates ?? undefined,
    isNegativeTest: source?.isNegativeTest,
    availability: {
      steps: native || legacy,
      expectedOutput: source?.expectedOutput != null,
      matchOptions: source?.matchOptions != null,
      predicates: source?.predicates != null,
    },
    provenance:
      mode === "draft"
        ? "current case"
        : mode === "live"
          ? "launch snapshot"
          : "saved snapshot",
  } as const;
}

/** Compare only captured fields; unknown historical fields are not changes. */
export function capturedCaseChanged(
  draft: CaseSnapshotFields,
  source: CaseViewSource | null | undefined,
) {
  const view = caseViewModel("historical", source);
  const before: CaseSnapshotFields = {},
    after: CaseSnapshotFields = {};
  if (view.availability.steps) {
    before.steps = view.steps;
    after.steps = draft.steps;
  }
  for (const key of [
    "expectedOutput",
    "matchOptions",
    "predicates",
    "isNegativeTest",
  ] as const) {
    if (source?.[key] != null) {
      Object.assign(before, { [key]: source[key] });
      Object.assign(after, { [key]: draft[key] });
    }
  }
  return !signaturesMatch(before, after);
}
