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
  NO_TOOL_PATH_KEY,
  buildEvalRunRouteFacts,
  evalCaseAggregationKey,
  type EvalRunRouteFacts,
  type EvalRunRouteFactsCase,
  type RouteFactsCatalog,
  type RouteFactsTrialInput,
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
    if (!isRecord(server) || !Array.isArray(server.tools)) continue;
    for (const tool of server.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string") continue;
      const name = tool.name.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Inline catalog on the run doc, or `notLoaded` for archived runs that
 * carry only a hash. No client fetch of snapshots.
 */
export function readRunToolCatalog(run: EvalSuiteRun): RouteFactsCatalog {
  const names = readToolNamesFromSnapshot(run.toolSnapshot);
  if (names === null || names.length === 0) {
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
  if (typeof iteration.testCaseId === "string" && iteration.testCaseId.length > 0) {
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
  };
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

function iterationsForRow(
  row: EvaluateCaseRow,
  iterations: readonly EvalIteration[],
): EvalIteration[] {
  if (row.testCaseId) {
    return iterations.filter((iteration) => iteration.testCaseId === row.testCaseId);
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
  if (rest > 0) {
    // `otherRoutes` is the document's own fold past its cap; its distinct
    // count is not carried, so the line can only say "and more".
    parts.push(`${rest}${routes.otherRoutes ? "+" : ""} other routes`);
  } else if (routes.otherRoutes) {
    parts.push(`${routes.otherRoutes.trials} took other routes`);
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
        `\`${swap.observed}\` called instead of \`${swap.expected}\` in ${swap.trials} trials`,
      );
    }
    if (catalogState === "notLoaded") {
      lines.push("catalog not loaded — substitutions were not classified");
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
