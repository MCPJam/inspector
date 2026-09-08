/**
 * Client adapter for {@link buildEvalRunRouteFacts}.
 *
 * Joins iterations the run page already has onto the SDK contract. The
 * case-variant key here is NOT the verdict's encoded key: it is
 * `evalCaseAggregationKey({ caseId: caseKey ?? testCaseId ?? "title:"+title,
 * executionVariant })`. Same function and separator, different identity.
 *
 * This module is the fallback producer. PR-3 replaces the document with a
 * persisted row when one exists; the copy helpers stay.
 */

import {
  FRICTION_NOT_MEASURED_REASON_LABELS,
  FRICTION_SIGNAL_LABELS,
  MAX_MISMATCH_TOOLS,
  NO_TOOL_PATH_KEY,
  SUSPECTED_CONDITION_CONFIDENCE_LABELS,
  SUSPECTED_CONDITION_LABELS,
  buildEvalRunRouteFacts,
  evalCaseAggregationKey,
  evalTrialFrictionSignalsSchema,
  suspectedConditionVerdictSchema,
  type EvalRunRouteFacts,
  type EvalRunRouteFactsCase,
  type EvalTrialFrictionSignals,
  type FrictionSignalKind,
  type RouteFactsCatalog,
  type RouteFactsTrialInput,
  type SuspectedConditionVerdict,
} from "@mcpjam/sdk/contract";

import type { EvalIteration, EvalSuiteRun } from "../evals/types";
import type { EvaluateCaseRow } from "./evaluate-case-row-model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readToolNamesFromSnapshot(snapshot: unknown): string[] | null {
  if (!isRecord(snapshot)) return null;
  const servers = snapshot.servers;
  if (!Array.isArray(servers)) return null;
  const names: string[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    // A server entry without a tool list, or a tool entry without a name,
    // is not "a server with no tools": it is a catalog this reader cannot
    // vouch for. Skipping the entry would hand route facts a `loaded`
    // catalog with holes in it, and every tool the trials called through
    // the hole would be filed as `outsideCatalog`.
    if (!isRecord(server) || !Array.isArray(server.tools)) return null;
    for (const tool of server.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") return null;
      const name = tool.name.trim();
      if (!name) return null;
      if (seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Inline catalog on the run doc, or `notLoaded` for archived runs that
 * carry only a hash. No client fetch of snapshots.
 *
 * A snapshot that is present but lists no tools is `loaded` with an empty
 * catalog: the server had nothing to offer, which is a fact about the
 * server, not a missing read. An absent snapshot is `notLoaded`, and so is
 * a malformed one — a server entry with no tool list, a tool with no name —
 * because a catalog the page cannot read is one it cannot vouch for.
 */
export function readRunToolCatalog(run: EvalSuiteRun): RouteFactsCatalog {
  const names = readToolNamesFromSnapshot(run.toolSnapshot);
  if (names === null) {
    return { state: "notLoaded" };
  }
  const snapshot = isRecord(run.toolSnapshot) ? run.toolSnapshot : null;
  const hash =
    (typeof run.toolSnapshotHash === "string" && run.toolSnapshotHash) ||
    (snapshot && typeof snapshot.snapshotHash === "string"
      ? snapshot.snapshotHash
      : undefined);
  return hash
    ? { state: "loaded", toolNames: names, hash }
    : { state: "loaded", toolNames: names };
}

function caseIdForIteration(iteration: EvalIteration): string {
  const caseKey = iteration.testCaseSnapshot?.caseKey;
  if (typeof caseKey === "string" && caseKey.length > 0) return caseKey;
  if (
    typeof iteration.testCaseId === "string" &&
    iteration.testCaseId.length > 0
  ) {
    return iteration.testCaseId;
  }
  const title = iteration.testCaseSnapshot?.title;
  return `title:${title ?? "Unknown"}`;
}

function executionVariantOf(iteration: EvalIteration) {
  const model = iteration.testCaseSnapshot?.model;
  if (typeof model !== "string" || model.length === 0) return undefined;
  const provider = iteration.testCaseSnapshot?.provider;
  return {
    model,
    ...(typeof provider === "string" && provider.length > 0
      ? { provider }
      : {}),
  };
}

/**
 * Map one loaded iteration onto the contract's trial input.
 *
 * Evaluator-error signal is `metadata.failureCategory === "evaluator"`,
 * matching the stage-analytics client reader.
 */
export function iterationToRouteTrial(
  iteration: EvalIteration,
): RouteFactsTrialInput {
  const caseId = caseIdForIteration(iteration);
  const executionVariant = executionVariantOf(iteration);
  const caseVariantKey = evalCaseAggregationKey({
    caseId,
    ...(executionVariant ? { executionVariant } : {}),
  });
  const failureCategory = iteration.metadata?.failureCategory;
  const friction = readTrialFrictionSignals(iteration);
  return {
    trialKey: iteration._id,
    status: iteration.status,
    result: iteration.result,
    actualToolCalls: iteration.actualToolCalls ?? [],
    expectedToolCalls: iteration.testCaseSnapshot?.expectedToolCalls ?? [],
    ...(iteration.testCaseSnapshot?.isNegativeTest === true
      ? { isNegativeTest: true }
      : {}),
    ...(failureCategory === "evaluator" ? { evaluatorErrored: true } : {}),
    caseVariantKey,
    ...(iteration.testCaseSnapshot?.caseKey
      ? { caseKey: iteration.testCaseSnapshot.caseKey }
      : iteration.testCaseId
        ? { caseKey: iteration.testCaseId }
        : {}),
    ...(executionVariant ? { executionVariant } : {}),
    ...(friction ? { frictionSignals: friction } : {}),
  };
}

/**
 * The trial's friction signals, or `undefined`.
 *
 * `safeParse`, never a cast: `metadata` is an open record that a reported run
 * can write into, and a document that does not validate must not become five
 * rates on the run page. Absent and invalid both read as "this trial supplied
 * none", which is what keeps the block off the document entirely.
 */
export function readTrialFrictionSignals(
  iteration: EvalIteration,
): EvalTrialFrictionSignals | undefined {
  const raw = iteration.metadata?.frictionSignals;
  if (raw === undefined) return undefined;
  const parsed = evalTrialFrictionSignalsSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The trial's suspected-condition verdict, or `undefined`.
 *
 * `safeParse` for the same reason: a verdict that does not validate must not
 * become a named server condition on the run page.
 */
export function readTrialSuspectedCondition(
  iteration: EvalIteration,
): SuspectedConditionVerdict | undefined {
  const raw = iteration.metadata?.suspectedConditionVerdict;
  if (raw === undefined) return undefined;
  const parsed = suspectedConditionVerdictSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The unverified case: say the verdict is not available, never guess at it. */
export function suspectedConditionUnavailable(
  iteration: EvalIteration,
): boolean {
  const raw = iteration.metadata?.suspectedConditionVerdict;
  return (
    raw !== undefined && readTrialSuspectedCondition(iteration) === undefined
  );
}

/**
 * The page-local producer. Returns `null` when the contract rejects what the
 * page holds: the section is optional, and a row the builder refuses must
 * not take the whole run page down with it.
 */
export function buildRunRouteFacts(
  run: EvalSuiteRun,
  iterations: readonly EvalIteration[],
): EvalRunRouteFacts | null {
  try {
    return buildEvalRunRouteFacts({
      run: {
        runId: String(run._id),
        suiteId: String(run.suiteId),
        ...(run.runGroupId ? { runGroupId: run.runGroupId } : {}),
        ...(run.configRevision ? { configRevision: run.configRevision } : {}),
        ...(typeof run.completedAt === "number"
          ? { runCompletedAt: run.completedAt }
          : {}),
        materializationState: "final",
        now: 0,
      },
      trials: iterations.map(iterationToRouteTrial),
      catalog: readRunToolCatalog(run),
    });
  } catch {
    return null;
  }
}

/**
 * The iterations that belong to one row.
 *
 * Exported because the per-trial friction line needs the same join the route
 * facts use: a second copy of this rule would let the two disagree about which
 * trials a row is made of.
 */
export function iterationsForRow(
  row: EvaluateCaseRow,
  iterations: readonly EvalIteration[],
): EvalIteration[] {
  if (row.testCaseId) {
    return iterations.filter(
      (iteration) => iteration.testCaseId === row.testCaseId,
    );
  }
  return iterations.filter(
    (iteration) =>
      (iteration.testCaseSnapshot?.title ?? "Unknown") === row.title,
  );
}

/**
 * Every case-variant document that belongs to one row.
 *
 * Rows come from `groupRunIterationsByTestCase`, which keys on the test case
 * and NOT on the execution variant, so a row that ran on two models holds two
 * variants and each has its own routes. Returned in document order; empty
 * when the document knows nothing about the row.
 */
export function routeFactsForRow(
  doc: EvalRunRouteFacts,
  row: EvaluateCaseRow,
  iterations: readonly EvalIteration[],
): EvalRunRouteFactsCase[] {
  const keys = new Set(
    iterationsForRow(row, iterations).map(
      (iteration) => iterationToRouteTrial(iteration).caseVariantKey,
    ),
  );
  if (row.caseKey) {
    const byCaseKey = doc.cases.filter(
      (entry) =>
        entry.caseKey === row.caseKey && keys.has(entry.caseVariantKey),
    );
    if (byCaseKey.length > 0) return byCaseKey;
  }
  return doc.cases.filter((entry) => keys.has(entry.caseVariantKey));
}

/** `claude (anthropic)` · `claude` · null when the case has no variant. */
export function variantLabel(facts: EvalRunRouteFactsCase): string | null {
  const variant = facts.executionVariant;
  if (!variant) return null;
  return variant.provider
    ? `${variant.model} (${variant.provider})`
    : variant.model;
}

/**
 * One line for the case-row header.
 *
 * Examples: `12 took \`search→get\`` · `7 took \`search→get\` · 2 called nothing · 1 looped on \`search\`` · `10 called nothing (expected)`.
 */
/** Routes named on the header line; the rest fold into "N other routes". */
export const ROUTE_LINE_MAX_ROUTES = 3;

type OtherRoutes = NonNullable<EvalRunRouteFactsCase["routes"]["otherRoutes"]>;

/**
 * How many distinct paths the document folded into `otherRoutes`, when it
 * says. The field is read defensively: the published contract does not
 * carry it yet, and a document without it can only say "and more".
 */
function otherRoutesDistinctPaths(other: OtherRoutes): number | null {
  const value = (other as { distinctPaths?: unknown }).distinctPaths;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

export function routeLine(facts: EvalRunRouteFactsCase): string {
  const { routes, mismatch } = facts;
  if (routes.includedTrials === 0) return "";
  const negative = mismatch.state === "excludedNegativeTest";
  const parts: string[] = [];
  // The document sorts routes count-desc, so the first three are the ones
  // most trials took.
  for (const route of routes.routes.slice(0, ROUTE_LINE_MAX_ROUTES)) {
    if (route.pathKey === NO_TOOL_PATH_KEY) {
      parts.push(
        negative
          ? `${route.trials} called nothing (expected)`
          : `${route.trials} called nothing`,
      );
      continue;
    }
    parts.push(`${route.trials} took \`${route.pathKey}\``);
  }
  const rest = routes.routes.length - ROUTE_LINE_MAX_ROUTES;
  const other = routes.otherRoutes;
  // `otherRoutes` is the document's own fold past its cap. When it carries
  // the distinct count, the line adds it up; when it does not, the line can
  // only say "and more".
  const folded = other ? otherRoutesDistinctPaths(other) : null;
  if (rest > 0) {
    if (!other) parts.push(`${rest} other routes`);
    else if (folded !== null) parts.push(`${rest + folded} other routes`);
    else parts.push(`${rest}+ other routes`);
  } else if (other) {
    parts.push(
      folded !== null
        ? `${folded} other routes`
        : `${other.trials} took other routes`,
    );
  }
  const loop = routes.loopedOn[0];
  if (loop) {
    parts.push(`${loop.trials} looped on \`${loop.tool}\``);
  }
  return parts.join(" · ");
}

/**
 * The header line for a row. One variant reads as before; several are
 * prefixed with the model so a reader knows which arm took which route.
 */
export function routeLineForRow(
  cases: readonly EvalRunRouteFactsCase[],
): string {
  if (cases.length <= 1) {
    const only = cases[0];
    return only ? routeLine(only) : "";
  }
  return cases
    .map((facts) => {
      const line = routeLine(facts);
      if (!line) return "";
      const label = variantLabel(facts);
      return label ? `${label}: ${line}` : line;
    })
    .filter((line) => line.length > 0)
    .join("; ");
}


/**
 * The per-trial line. OBSERVATION WORDS ONLY.
 *
 * Every phrase here comes from `FRICTION_SIGNAL_LABELS` or names a call index,
 * and none of them says "wasted", "unnecessary" or "the server". The signals
 * are patterns with benign readings, and a line that pre-judged one would make
 * the reader's first act a defence rather than a look.
 *
 * Returns `null` when there is nothing to say — a measured trial with no
 * signals gets no line at all, because "no friction signals" is noise on the
 * overwhelming majority of trials.
 */
export function frictionLineForTrial(
  signals: EvalTrialFrictionSignals | undefined,
): string | null {
  if (!signals) return null;
  if (signals.state === "notMeasured") {
    const reason = signals.notMeasuredReason;
    return `friction signals: not measured — ${
      reason ? FRICTION_NOT_MEASURED_REASON_LABELS[reason] : "no reason given"
    }`;
  }
  if (signals.signals.length === 0) return null;

  const parts: string[] = [];
  for (const signal of signals.signals) {
    switch (signal.kind) {
      case "identifierSurfacedUnused":
        parts.push(
          `\`${signal.toolName}\` returned ${
            signal.identifierCount === 1 ? "an identifier" : "identifiers"
          } (${signal.identifierKeyPaths.join(", ")}) at call ${
            signal.informationCallIndex
          } that no later call used`,
        );
        break;
      case "searchRepeatedAfterIdentifier":
        parts.push(
          `\`${signal.toolName}\` was called again at ${callList(
            signal.repeatCallIndexes,
          )}`,
        );
        break;
      case "identicalRetry":
        parts.push(
          `\`${signal.toolName}\` repeated with identical arguments at call ${
            signal.callIndex
          }${signal.afterError ? " after an error" : ""}`,
        );
        break;
      case "changedRetry":
        parts.push(
          `\`${signal.toolName}\` called again with changed arguments at call ${
            signal.callIndex
          }${signal.afterError ? " after an error" : ""}`,
        );
        break;
      case "paginationContinuation":
        parts.push(
          `\`${signal.toolName}\` continued pagination at call ${
            signal.callIndex
          } (${signal.paginationKeys.join(", ")})`,
        );
        break;
    }
  }
  return `${frictionHeading(signals.signals[0]!.kind)}: ${parts.join("; ")}`;
}

/**
 * The heading the line opens with, from the FIRST signal's kind.
 *
 * Three headings for five kinds: what a reader does next is the same for both
 * identifier kinds and the same for both retry kinds, and a heading per kind
 * would be five words that mean three things.
 */
export function frictionHeading(kind: FrictionSignalKind): string {
  switch (kind) {
    case "identifierSurfacedUnused":
    case "searchRepeatedAfterIdentifier":
      return "Possible detour";
    case "identicalRetry":
    case "changedRetry":
      return "Retry";
    case "paginationContinuation":
      return "Pagination";
  }
}

function callList(indexes: readonly number[]): string {
  if (indexes.length === 1) return `call ${indexes[0]}`;
  return `calls ${indexes.slice(0, -1).join(", ")} and ${
    indexes[indexes.length - 1]
  }`;
}

/**
 * The line under the signal. SUSPECTED, and it never says "caused".
 *
 * Four shapes, and the differences between them are the point:
 *
 *   - a named condition reads "Suspected condition: X (high confidence)" and
 *     carries one "Next:" naming a server lever;
 *   - `unclear` reads "could not attribute" with NO Next — there is nothing to
 *     act on, and inventing one would send a reader after a condition the
 *     judge explicitly declined to name;
 *   - `responseWasClear` reads as itself with no Next either: it is the honest
 *     negative, and attaching a next step to it would manufacture server work
 *     out of an answer that named no server problem;
 *   - `skipped` / `error` / absent produce NO line at all. "We never looked"
 *     must not read as "we looked and found nothing".
 */
export function suspectedConditionLineForTrial(
  verdict: SuspectedConditionVerdict | undefined,
): { line: string; next?: string } | null {
  if (!verdict || verdict.status !== "scored") return null;
  const condition = SUSPECTED_CONDITION_LABELS[verdict.condition];
  if (verdict.condition === "unclear") {
    return { line: "Suspected condition: could not attribute" };
  }
  const confidence = SUSPECTED_CONDITION_CONFIDENCE_LABELS[verdict.confidence];
  const line = `Suspected condition: ${condition} (${confidence})`;
  if (verdict.condition === "responseWasClear" || !verdict.remediation) {
    return { line };
  }
  return { line, next: verdict.remediation };
}

/** The words a case-level rate is reported under. One per signal kind. */
const FRICTION_RATE_LABELS: Record<FrictionSignalKind, string> = {
  identifierSurfacedUnused: FRICTION_SIGNAL_LABELS.identifierSurfacedUnused,
  searchRepeatedAfterIdentifier:
    FRICTION_SIGNAL_LABELS.searchRepeatedAfterIdentifier,
  identicalRetry: FRICTION_SIGNAL_LABELS.identicalRetry,
  changedRetry: FRICTION_SIGNAL_LABELS.changedRetry,
  paginationContinuation: FRICTION_SIGNAL_LABELS.paginationContinuation,
};

/**
 * Lines for the "Expected vs observed" expander. Name-level only.
 * Substitution only for the one-to-one in-catalog shape. Never writes
 * "ended with a question: no".
 */
export function mismatchLines(
  facts: EvalRunRouteFactsCase,
  catalogState: EvalRunRouteFacts["catalogState"],
): string[] {
  const lines: string[] = [];
  if (facts.mismatch.state === "measured") {
    // The mismatch rows are counted over gradeable trials — included and not
    // a negative test — which the document carries so no line borrows the
    // route rollup's `includedTrials`.
    const opportunity = facts.mismatch.gradeableTrials;
    for (const expected of facts.mismatch.expected) {
      if (expected.notCalledIn === 0) continue;
      lines.push(
        `expected \`${expected.tool}\` not called in ${expected.notCalledIn} of ${opportunity}`,
      );
    }
    for (const unexpected of facts.mismatch.unexpected) {
      const failed =
        unexpected.calledInFailed > 0
          ? ` (${unexpected.calledInFailed} failed)`
          : "";
      lines.push(
        `\`${unexpected.tool}\` called in ${unexpected.calledIn} of ${opportunity}${failed}`,
      );
    }
    for (const swap of facts.mismatch.substitutions) {
      lines.push(
        `\`${swap.observed}\` called instead of \`${swap.expected}\` in ${swap.trials} ${swap.trials === 1 ? "iteration" : "iterations"}`,
      );
    }
    if (facts.mismatch.truncated) {
      // The document caps each list at MAX_MISMATCH_TOOLS. The expected and
      // unexpected lists keep the most-seen tools; the substitution list is
      // ordered by name. So the line states the cap and claims nothing about
      // which rows survived it.
      lines.push(`mismatch lists capped at ${MAX_MISMATCH_TOOLS} entries each`);
    }
    if (catalogState === "notLoaded") {
      lines.push("catalog not loaded. Substitutions were not classified");
    }
  }
  if (facts.routes.endedWithQuestion.state === "notMeasured") {
    lines.push("ended with a question: not measured");
  } else if (
    facts.routes.endedWithQuestion.state === "measured" &&
    facts.routes.endedWithQuestion.numerator > 0
  ) {
    lines.push(
      `ended with a question: ${facts.routes.endedWithQuestion.numerator} of ${facts.routes.endedWithQuestion.denominator}`,
    );
  }
  // The friction rates, in the same `n of m` grammar. The two identifier
  // rates carry a SMALLER denominator than the three adjacency ones — a trial
  // whose results were not retained looked for retries and never looked for an
  // identifier — so each line states its own `m` rather than borrowing one.
  const friction = facts.routes.frictionSignals;
  if (friction) {
    const kinds = Object.keys(FRICTION_RATE_LABELS) as FrictionSignalKind[];
    for (const kind of kinds) {
      const rate = friction[kind];
      const label = FRICTION_RATE_LABELS[kind].toLowerCase();
      if (rate.state === "notMeasured") {
        lines.push(`${label}: not measured`);
      } else if (rate.numerator > 0) {
        lines.push(`${label}: ${rate.numerator} of ${rate.denominator}`);
      }
    }
  }
  return lines;
}

export function routeLinesByRowKey(
  doc: EvalRunRouteFacts,
  rows: readonly EvaluateCaseRow[],
  iterations: readonly EvalIteration[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    const line = routeLineForRow(routeFactsForRow(doc, row, iterations));
    if (line) map.set(row.key, line);
  }
  return map;
}
