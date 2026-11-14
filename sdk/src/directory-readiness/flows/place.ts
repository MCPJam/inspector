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
 * A run that knows a dependency failed says so in the reason instead
 * ({@link directoryBlockedReason}), which holds even when another check with
 * the same need reached a verdict: a server that answers discovery and
 * refuses the MCP session blocks the tool checks and nothing else.
 *
 * Pure. Safe from the browser entry.
 */

import { isDispositiveDirectoryFinding } from "../types.js";
import type { DirectoryReadinessFinding } from "../types.js";
import { directoryFlowField, withDirectoryFlowDefaults } from "./fields.js";
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
  /** Names of the project's secrets that hold a value (see `validateDirectoryAnswers`). */
  savedSecrets?: readonly string[];
}

const BLOCKED = "blocked: ";

/**
 * The `notEvaluatedReason` of a check a failed dependency left without a
 * verdict, e.g. "blocked: the server could not be reached: fetch failed".
 */
export function directoryBlockedReason(failure: string): string {
  return `${BLOCKED}${failure}`;
}

/**
 * The placement of a finding id: its own, else the family (`prefix.*`) whose
 * prefix it starts with, for an id the engine builds at run time.
 */
export function directoryPlacementOf(
  flow: DirectoryFlow,
  checkId: string
): DirectoryCheckPlacement | undefined {
  return (
    flow.placements.find((placement) => placement.checkId === checkId) ??
    flow.placements.find(
      (placement) =>
        placement.checkId.endsWith(".*") &&
        checkId.startsWith(placement.checkId.slice(0, -1))
    )
  );
}

export function placeDirectoryResults(
  input: PlaceDirectoryResultsInput
): PlacedStep[] {
  const { flow, findings = [] } = input;
  const placements = new Map(
    findings.flatMap((finding) => {
      const placement = directoryPlacementOf(flow, finding.id);
      return placement ? [[finding.id, placement] as const] : [];
    })
  );
  const lacking = lackingDependencies(findings, placements);
  const changed = (withConfirmation: boolean) =>
    input.gradedAnswers
      ? changedKeys(flow, input.gradedAnswers, input.answers, withConfirmation)
      : new Set<string>();
  const changedValues = changed(false);
  const changedStanding = changed(true);
  const stepIds = new Set(flow.steps.map((step) => step.id));
  const fallback = flow.steps[flow.steps.length - 1]?.id ?? "";

  const placed = findings.map((finding): PlacedFinding => {
    const placement = placements.get(finding.id);
    const wanted = placement?.step ?? flow.laneSteps[finding.lane];
    const step =
      wanted !== undefined && stepIds.has(wanted) ? wanted : fallback;
    let evidenceStatus = statusOf(finding, placement, lacking);
    const changedNow = placement?.readsConfirmation
      ? changedStanding
      : changedValues;
    const staleBecause = (placement?.reads ?? []).filter((key) =>
      changedNow.has(key)
    );
    const current =
      evidenceStatus === "established" || evidenceStatus === "inconclusive";
    if (current && staleBecause.length > 0) {
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
    savedSecrets: input.savedSecrets,
  });
  const declared = new Set(
    flow.steps.flatMap((step) => step.fields.map((field) => field.key))
  );
  return flow.steps.map((step) => {
    const keys = new Set(step.fields.map((field) => field.key));
    // An issue for a key no step declares, such as an answer to a field the
    // flow has since dropped, goes where an unplaced finding goes.
    const fieldIssues = issues.filter(
      (issue) =>
        keys.has(issue.key) ||
        (step.id === fallback && !declared.has(issue.key))
    );
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
    return finding.notEvaluatedReason?.startsWith(BLOCKED) ||
      dependenciesOf(finding, placement).some((name) => lacking.has(name))
      ? "blocked"
      : "not-tested";
  }
  return isUnsureModelFlag(finding) ? "inconclusive" : "established";
}

/**
 * A model's flag it was unsure of. A model's flag is never a verdict, and an
 * unsure one reads as inconclusive: a warning, never a pass.
 */
export function isUnsureModelFlag(finding: DirectoryReadinessFinding): boolean {
  return (
    finding.provenance === "llm" &&
    finding.class === "heuristic" &&
    finding.status === "informational" &&
    finding.details?.confidence === "low"
  );
}

/**
 * Answer keys whose value or wording revision differs between two sets of
 * stored answers, and with `withConfirmation` a declaration's origin too.
 */
function changedKeys(
  flow: DirectoryFlow,
  before: readonly DirectoryAnswer[],
  after: readonly DirectoryAnswer[],
  withConfirmation: boolean
): Set<string> {
  const print = (answers: readonly DirectoryAnswer[]) =>
    fingerprints(
      flow,
      withDirectoryFlowDefaults(flow, answers),
      withConfirmation
    );
  const then = print(before);
  const now = print(after);
  return new Set(
    [...new Set([...then.keys(), ...now.keys()])].filter(
      (key) => then.get(key) !== now.get(key)
    )
  );
}

function fingerprints(
  flow: DirectoryFlow,
  answers: readonly DirectoryAnswer[],
  withConfirmation: boolean
): Map<string, string> {
  return new Map(
    answers.map((answer) => {
      const standing =
        withConfirmation && directoryFlowField(flow, answer.key)?.declaration
          ? [answer.origin]
          : [];
      return [
        answer.key,
        JSON.stringify([
          sortedRecords(answer.value),
          answer.wordingRevision,
          ...standing,
        ]),
      ];
    })
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
