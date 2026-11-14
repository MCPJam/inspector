/**
 * A run's findings put where the portal would show them, each with how far
 * it can still be trusted.
 *
 * WHY "LACKED" IS READ FROM THE FINDINGS. A check names what it cannot reach
 * a verdict without: runner capabilities on the finding
 * (`requiresCapabilities`), and the server, a reviewer sign-in, a model or a
 * package on its placement (`needs`). By construction such a check is never
 * satisfied or violated without them. So a dependency was present in the run
 * exactly when some check that declares it reached a verdict, and when none
 * did, every unevaluated check that declares it is `blocked` rather than
 * merely not tested. The reason stays the finding's own `notEvaluatedReason`.
 *
 * Pure. Safe from the browser entry.
 */

import { isDispositiveDirectoryFinding } from "../types.js";
import type { DirectoryReadinessFinding } from "../types.js";
import { withDirectoryFlowDefaults } from "./fields.js";
import { validateDirectoryAnswers } from "./validate.js";
import type {
  DirectoryAnswer,
  DirectoryCheckPlacement,
  DirectoryEvidenceStatus,
  DirectoryFieldIssue,
  DirectoryFlow,
  PlacedFinding,
  PlacedStep,
} from "./types.js";

export interface PlaceDirectoryResultsInput {
  flow: DirectoryFlow;
  /** The stored answers now; the flow's defaults are merged in here. */
  answers: readonly DirectoryAnswer[];
  /** From the latest run's report. */
  findings?: readonly DirectoryReadinessFinding[];
  /** The stored answers as that run graded them, to tell what went stale. */
  gradedAnswers?: readonly DirectoryAnswer[];
  /** Which page's field issues to report: the step form's or the review page's. */
  on?: "form" | "review";
}

export function placeDirectoryResults(
  input: PlaceDirectoryResultsInput
): PlacedStep[] {
  const { flow, findings = [] } = input;
  const placements = new Map(
    flow.placements.map((placement) => [placement.checkId, placement])
  );
  const lacking = lackingDependencies(findings, placements);
  const changed = input.gradedAnswers
    ? changedKeys(flow, input.gradedAnswers, input.answers)
    : new Set<string>();
  const stepIds = new Set(flow.steps.map((step) => step.id));
  const fallback = flow.steps[flow.steps.length - 1]?.id ?? "";

  const placed = findings.map((finding): PlacedFinding => {
    const placement = placements.get(finding.id);
    const wanted = placement?.step ?? flow.laneSteps[finding.lane];
    const step =
      wanted !== undefined && stepIds.has(wanted) ? wanted : fallback;
    let evidenceStatus = statusOf(finding, placement, lacking);
    const staleBecause = (placement?.reads ?? []).filter((key) =>
      changed.has(key)
    );
    if (evidenceStatus === "established" && staleBecause.length > 0) {
      evidenceStatus = "stale";
    }
    return {
      finding,
      step,
      ...(placement?.field ? { field: placement.field } : {}),
      evidenceStatus,
      ...(evidenceStatus === "stale" ? { staleBecause } : {}),
    };
  });

  const issues = validateDirectoryAnswers(flow, input.answers, {
    on: input.on,
  });
  return flow.steps.map((step) => {
    const keys = new Set(step.fields.map((field) => field.key));
    const fieldIssues = issues.filter((issue) => keys.has(issue.key));
    const stepFindings = placed.filter((entry) => entry.step === step.id);
    return {
      step: step.id,
      fieldIssues,
      findings: stepFindings,
      counts: countStep(fieldIssues, stepFindings),
    };
  });
}

function dependenciesOf(
  finding: DirectoryReadinessFinding,
  placement: DirectoryCheckPlacement | undefined
): string[] {
  return [
    ...(finding.requiresCapabilities ?? []).map((name) => `capability:${name}`),
    ...(placement?.needs ?? []).map((name) => `need:${name}`),
  ];
}

function lackingDependencies(
  findings: readonly DirectoryReadinessFinding[],
  placements: ReadonlyMap<string, DirectoryCheckPlacement>
): Set<string> {
  const declared = new Set<string>();
  const present = new Set<string>();
  for (const finding of findings) {
    const verdict =
      finding.status === "satisfied" || finding.status === "violated";
    for (const dependency of dependenciesOf(
      finding,
      placements.get(finding.id)
    )) {
      declared.add(dependency);
      if (verdict) present.add(dependency);
    }
  }
  return new Set([...declared].filter((name) => !present.has(name)));
}

function statusOf(
  finding: DirectoryReadinessFinding,
  placement: DirectoryCheckPlacement | undefined,
  lacking: ReadonlySet<string>
): DirectoryEvidenceStatus {
  if (finding.status === "not-evaluated") {
    return dependenciesOf(finding, placement).some((name) => lacking.has(name))
      ? "blocked"
      : "not-tested";
  }
  // A model's observation is a flag, never a verdict, and one it was unsure
  // of has to read as unsure.
  const unsure =
    finding.provenance === "llm" &&
    finding.class === "heuristic" &&
    finding.status === "informational" &&
    finding.details?.confidence === "low";
  return unsure ? "inconclusive" : "established";
}

/** Answer keys whose value or wording revision differs between two sets of stored answers. */
function changedKeys(
  flow: DirectoryFlow,
  before: readonly DirectoryAnswer[],
  after: readonly DirectoryAnswer[]
): Set<string> {
  const then = fingerprints(withDirectoryFlowDefaults(flow, before));
  const now = fingerprints(withDirectoryFlowDefaults(flow, after));
  return new Set(
    [...new Set([...then.keys(), ...now.keys()])].filter(
      (key) => then.get(key) !== now.get(key)
    )
  );
}

function fingerprints(
  answers: readonly DirectoryAnswer[]
): Map<string, string> {
  return new Map(
    answers.map((answer) => [
      answer.key,
      JSON.stringify([sortedRecords(answer.value), answer.wordingRevision]),
    ])
  );
}

/** Row records with their keys in one order, so key order never reads as a change. */
function sortedRecords(value: DirectoryAnswer["value"]): unknown {
  if (!Array.isArray(value)) return value;
  return (value as ReadonlyArray<string | Record<string, string>>).map((row) =>
    typeof row === "string"
      ? row
      : Object.entries(row).sort(([a], [b]) => a.localeCompare(b))
  );
}

function countStep(
  fieldIssues: readonly DirectoryFieldIssue[],
  findings: readonly PlacedFinding[]
): PlacedStep["counts"] {
  const count = (test: (entry: PlacedFinding) => boolean) =>
    findings.filter(test).length;
  const current = (entry: PlacedFinding) =>
    entry.evidenceStatus === "established" ||
    entry.evidenceStatus === "inconclusive";
  return {
    toFix: fieldIssues.length,
    blockers: count(
      (entry) =>
        current(entry) &&
        entry.finding.status === "violated" &&
        isDispositiveDirectoryFinding(entry.finding)
    ),
    likelyFlags: count(
      (entry) =>
        current(entry) &&
        ((entry.finding.status === "violated" &&
          !isDispositiveDirectoryFinding(entry.finding)) ||
          (entry.finding.status === "informational" &&
            entry.finding.provenance === "llm"))
    ),
    notChecked: count((entry) => !current(entry)),
    passed: count(
      (entry) => current(entry) && entry.finding.status === "satisfied"
    ),
  };
}
