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

export function buildRunRouteFacts(
  run: EvalSuiteRun,
  iterations: readonly EvalIteration[],
): EvalRunRouteFacts {
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

export function routeFactsForRow(
  doc: EvalRunRouteFacts,
  row: EvaluateCaseRow,
  iterations: readonly EvalIteration[],
): EvalRunRouteFactsCase | null {
  const keys = new Set(
    iterationsForRow(row, iterations).map(
      (iteration) => iterationToRouteTrial(iteration).caseVariantKey,
    ),
  );
  if (row.caseKey) {
    const byCaseKey = doc.cases.find(
      (entry) => entry.caseKey === row.caseKey && keys.has(entry.caseVariantKey),
    );
    if (byCaseKey) return byCaseKey;
  }
  return doc.cases.find((entry) => keys.has(entry.caseVariantKey)) ?? null;
}

/**
 * One line for the case-row header.
 *
 * Examples: `12 took \`search→get\`` · `7 took \`search→get\` · 2 called nothing · 1 looped on \`search\`` · `10 called nothing (expected)`.
 */
export function routeLine(facts: EvalRunRouteFactsCase): string {
  const { routes, mismatch } = facts;
  if (routes.includedTrials === 0) return "";
  const negative = mismatch.state === "excludedNegativeTest";
  const parts: string[] = [];
  for (const route of routes.routes) {
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
  for (const loop of routes.loopedOn) {
    parts.push(`${loop.trials} looped on \`${loop.tool}\``);
  }
  return parts.join(" · ");
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
    for (const expected of facts.mismatch.expected) {
      if (expected.notCalledIn === 0) continue;
      lines.push(
        `expected \`${expected.tool}\` not called in ${expected.notCalledIn} of ${expected.expectedIn}`,
      );
    }
    const opportunity = facts.routes.includedTrials;
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
    const facts = routeFactsForRow(doc, row, iterations);
    if (!facts) continue;
    const line = routeLine(facts);
    if (line) map.set(row.key, line);
  }
  return map;
}
