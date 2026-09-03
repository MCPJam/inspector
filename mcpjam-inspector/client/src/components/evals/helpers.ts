import {
  CommitGroup,
  EvalCase,
  EvalIteration,
  EvalSuite,
  EvalSuiteOverviewEntry,
  EvalSuiteRun,
  SuiteAggregate,
  TagGroupAggregate,
} from "./types";
import { computeIterationResult } from "./pass-criteria";
import { toast } from "sonner";
import { RESULT_STATUS } from "./constants";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { clientDisplayName } from "@/lib/client-display-name";

/**
 * What servers can this suite see at run-time? Mirrors the precedence
 * `startTestSuiteRun` applies server-side (testSuites.ts ~4584):
 *
 *   1. `suite.serverAttachment` (standalone) — overrides EVERYTHING for
 *      ALL hosts. Per-host picks and the legacy flat `environment.servers`
 *      list are inert when this is set.
 *   2. Per-host `hostAttachments[].resolvedServerNames` ∪ legacy
 *      `environment.servers`.
 *
 * Without the standalone short-circuit, a suite that had a per-host
 * attachment carrying old servers (e.g. seeded at suite-create time)
 * and later got a narrower standalone picked still gates "Run all" /
 * per-case Run on the shadowed per-host set — including any OAuth
 * servers in there, which surfaces as a spurious "Re-authenticate with
 * <staging>" toast even though the active attachment doesn't use them.
 */
export function getEffectiveSuiteServers(
  // Accept a structurally narrower suite than the full `EvalSuite`: some
  // call sites (the test-case overview's lightweight Convex row) carry
  // an optional `environment.servers` rather than the required shape.
  // The body already optional-chains both fields, so widening the param
  // is safe and avoids forcing every caller to assert into a stricter
  // type than it actually has.
  suite: {
    environment?: { servers?: string[] } | undefined;
    hostAttachments?: EvalSuite["hostAttachments"];
    serverAttachment?: EvalSuite["serverAttachment"];
  }
): string[] {
  if (suite.serverAttachment) {
    return Array.from(
      new Set(suite.serverAttachment.resolvedServerNames ?? [])
    );
  }
  const flatServers = suite.environment?.servers ?? [];
  const hostAttachmentServers =
    suite.hostAttachments?.flatMap(
      (attachment) => attachment.resolvedServerNames ?? []
    ) ?? [];
  if (hostAttachmentServers.length === 0) {
    return flatServers;
  }
  return Array.from(new Set([...flatServers, ...hostAttachmentServers]));
}

export type SuiteHostRunPlan = {
  namedHostId?: string;
  hostName: string | null;
  serverIds: string[];
};

function suiteDefaultRunPlan(serverIds: string[]): SuiteHostRunPlan {
  return {
    namedHostId: undefined,
    hostName: null,
    serverIds,
  };
}

function hostAttachmentRunPlan(
  attachment: NonNullable<EvalSuite["hostAttachments"]>[number],
  fallbackServerIds: string[],
  useAttachmentServerIds = true
): SuiteHostRunPlan {
  return {
    namedHostId: attachment.namedHostId,
    hostName: attachment.hostName ?? "host",
    serverIds:
      useAttachmentServerIds && attachment.resolvedServerNames.length > 0
        ? attachment.resolvedServerNames
        : fallbackServerIds,
  };
}

export function buildSuiteHostRunPlans(
  suite: {
    environment?: { servers?: string[] } | undefined;
    hostAttachments?: EvalSuite["hostAttachments"];
    serverAttachment?: EvalSuite["serverAttachment"];
  },
  fallbackServerIds = getEffectiveSuiteServers(suite)
): SuiteHostRunPlan[] {
  const suiteServerIds = fallbackServerIds;
  const attachments = suite.hostAttachments ?? [];
  const useAttachmentServerIds = !suite.serverAttachment;
  if (attachments.length === 0) {
    return [suiteDefaultRunPlan(suiteServerIds)];
  }
  return attachments.map((attachment) =>
    hostAttachmentRunPlan(attachment, suiteServerIds, useAttachmentServerIds)
  );
}

export type SuiteRunPlan = SuiteHostRunPlan & {
  /** Set on environment plans; forwarded on the run request wire. */
  environmentId?: string;
  /** Display-only (toasts/labels); the server re-resolves authoritatively. */
  environmentName?: string;
};

/**
 * Run-all fan-out plans. When the suite has attached project environments,
 * the ENVIRONMENT axis replaces the host axis: one plan per environment, in
 * attach order, carrying `{environmentId, environmentName}` ONLY —
 * `serverIds` stays EMPTY because `listEnvironments` intentionally returns
 * pointers, not a closed execution set. The Inspector server performs the
 * authoritative resolution (P0.1 `resolveEnvironmentForLaunch`) and returns
 * a readable auth/connection error for that exact closed set; any browser
 * readiness check is advisory only. Suites without environments delegate to
 * {@link buildSuiteHostRunPlans} unchanged.
 */
export function buildSuiteRunPlans(
  suite: {
    environment?: { servers?: string[] } | undefined;
    hostAttachments?: EvalSuite["hostAttachments"];
    serverAttachment?: EvalSuite["serverAttachment"];
    environmentIds?: string[];
  },
  environments?: Array<{ environmentId: string; name: string }>,
  fallbackServerIds?: string[]
): SuiteRunPlan[] {
  const envIds = suite.environmentIds ?? [];
  if (envIds.length > 0) {
    return envIds.map((environmentId) => ({
      namedHostId: undefined,
      hostName: null,
      serverIds: [],
      environmentId,
      environmentName:
        environments?.find((e) => e.environmentId === environmentId)?.name ??
        environmentId,
    }));
  }
  return buildSuiteHostRunPlans(suite, fallbackServerIds);
}

/**
 * Number of plans `buildSuiteRunPlans` produces for this suite — it delegates and
 * reads `.length`, so parity holds by construction. Used by the pre-run credit
 * estimate to tell the backend how wide the Run-all fan-out is (environments,
 * then hosts, then the single default plan).
 *
 * Kept immediately beside `buildSuiteRunPlans` and covered by a parity test
 * against `buildSuiteRunPlans(...).length`: if the plan shape ever gains another
 * axis, a count that silently lags would understate every estimate.
 */
export function countSuiteRunPlans(
  suite: {
    environment?: { servers?: string[] } | undefined;
    hostAttachments?: EvalSuite["hostAttachments"];
    serverAttachment?: EvalSuite["serverAttachment"];
    environmentIds?: string[];
  },
  environments?: Array<{ environmentId: string; name: string }>,
  fallbackServerIds?: string[]
): number {
  return buildSuiteRunPlans(suite, environments, fallbackServerIds).length;
}

export function getSelectedSuiteHostRunPlan(
  suite: {
    environment?: { servers?: string[] } | undefined;
    hostAttachments?: EvalSuite["hostAttachments"];
    serverAttachment?: EvalSuite["serverAttachment"];
  },
  namedHostId: string | undefined
): SuiteHostRunPlan {
  const suiteServerIds = getEffectiveSuiteServers(suite);
  const attachment = namedHostId
    ? suite.hostAttachments?.find(
        (candidate) => candidate.namedHostId === namedHostId
      )
    : null;
  if (!attachment) {
    return suiteDefaultRunPlan(suiteServerIds);
  }
  return hostAttachmentRunPlan(
    attachment,
    suiteServerIds,
    !suite.serverAttachment
  );
}

export function formatTime(ts?: number) {
  return ts ? new Date(ts).toLocaleString() : "—";
}

export function getIterationRecencyTimestamp(
  iteration: Pick<EvalIteration, "updatedAt" | "startedAt" | "createdAt">
) {
  return iteration.updatedAt ?? iteration.startedAt ?? iteration.createdAt ?? 0;
}

export function formatDuration(durationMs: number) {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  const totalSeconds = Math.round(durationMs / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatRunId(runId: string): string {
  // Format Convex ID for display (e.g., "j1234567890abcdef" -> "j1234567")
  return runId.substring(0, 8);
}

// ─── Run execution context (Project Environments, Phase 3) ───────────────────

/**
 * The launch provenance the context helpers below read. Structurally narrower
 * than `EvalSuiteRun` on purpose: case-history and rail code carries partial
 * run rows, and every call site only ever needs these two fields.
 *
 * NOTE `configSnapshot.environment` (the flat `{ servers }` bag) is a THIRD,
 * unrelated meaning of the word "environment" — a raw server-name list. It is
 * deliberately not read here; only `configSnapshot.environmentRef` identifies
 * a Project Environment.
 */
export type RunContextSource = {
  namedHostId?: string;
  configSnapshot?: {
    environmentRef?: {
      environmentId: string;
      name: string;
      revision: number;
    };
  };
};

/** The Project Environment this run resolved at start, or `null` (legacy run). */
export function runEnvironmentRef(
  run: RunContextSource
): NonNullable<
  NonNullable<RunContextSource["configSnapshot"]>["environmentRef"]
> | null {
  return run.configSnapshot?.environmentRef ?? null;
}

/**
 * Canonical identity for "which context produced this run" — the unit every
 * user-visible run grouping/labelling keys on.
 *
 * Keyed by the environment ID, **never** the revision. An environment is
 * live-editable, so every edit bumps `revision`; keying on it would shatter a
 * suite's history into singletons on each edit. Two environments that resolve
 * to the SAME host stay distinct because the ids differ. Legacy/host-backed
 * runs key on `namedHostId` exactly as before.
 *
 * This is NOT the host dimension: cross-host comparison code that deliberately
 * compares resolved hosts must keep using `namedHostId`.
 */
export function runContextKey(run: RunContextSource): string {
  const ref = runEnvironmentRef(run);
  return ref
    ? `environment:${ref.environmentId}`
    : `host:${run.namedHostId ?? "none"}`;
}

/**
 * The run's resolved HOST name only — never its environment name. Falls back to
 * a truncated host id, and returns `null` when the run names no host.
 *
 * This is the branch the `project-environments-enabled` kill-switch falls back
 * to. An environment-backed run carries no `namedHostId`, so with the flag off
 * it yields `null` here and the caller shows a neutral placeholder rather than
 * leaking the environment name through a host-shaped chip.
 */
export function runHostLabel(
  run: RunContextSource,
  hostNamesById?: Map<string, string | null>
): string | null {
  if (!run.namedHostId) return null;
  return hostNamesById?.get(run.namedHostId) ?? formatRunId(run.namedHostId);
}

/**
 * Display name for a run's context: the environment name for environment-backed
 * runs, the resolved host name (falling back to a truncated id) for legacy runs.
 * `null` when the run names neither — the caller decides what to show instead.
 *
 * This CAN return environment identity, so every call site must sit behind
 * `project-environments-enabled`; the flag-off branch uses
 * {@link runHostLabel} instead.
 */
export function runContextLabel(
  run: RunContextSource,
  hostNamesById?: Map<string, string | null>
): string | null {
  const ref = runEnvironmentRef(run);
  if (ref) return ref.name;
  return runHostLabel(run, hostNamesById);
}

/**
 * The exact revision this run pinned, e.g. `"rev 4"`. Belongs on an individual
 * RUN row only — a group header spans many revisions and must never claim one
 * arbitrary revision of them.
 */
export function runRevisionLabel(run: RunContextSource): string | null {
  const ref = runEnvironmentRef(run);
  return ref ? `rev ${ref.revision}` : null;
}

/**
 * `namedHostId` → display name across every host a suite surface can name: the
 * suite's attachments (authoritative label) plus the project host list, which
 * is the ONLY source for a host with no attachment — notably the host an
 * environment-backed run resolved to.
 */
export function buildHostNamesById(
  attachments:
    | Array<{ namedHostId: string; hostName: string | null }>
    | undefined,
  projectHosts:
    | Array<{ hostId: string; name: string; displayName?: string }>
    | undefined
): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const projectHostById = new Map(
    (projectHosts ?? []).map((host) => [host.hostId, host]),
  );
  for (const host of projectHosts ?? []) {
    map.set(host.hostId, clientDisplayName(host));
  }
  for (const attachment of attachments ?? []) {
    const projectHost = projectHostById.get(attachment.namedHostId);
    const attachmentMatchesRawName =
      projectHost !== undefined &&
      attachment.hostName?.trim().toLowerCase() ===
        projectHost.name.trim().toLowerCase();
    map.set(
      attachment.namedHostId,
      projectHost && (attachment.hostName === null || attachmentMatchesRawName)
        ? clientDisplayName(projectHost)
        : attachment.hostName ?? map.get(attachment.namedHostId) ?? null
    );
  }
  return map;
}

/** Distinct context keys across a set of runs, in first-seen order. */
export function runContextKeys(runs: RunContextSource[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const run of runs) {
    const key = runContextKey(run);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

/** True when any run in the set launched against a Project Environment. */
export function hasEnvironmentRun(runs: RunContextSource[]): boolean {
  return runs.some((run) => runEnvironmentRef(run) !== null);
}

/**
 * Group-level revision summary — a RANGE or count, never a single arbitrary
 * revision. `"rev 4"` only when every environment run in the group agrees;
 * `"rev 2–7"` when they span. `null` when the group has no environment runs.
 */
export function runContextRevisionSummary(
  runs: RunContextSource[]
): string | null {
  const revisions = runs
    .map((run) => runEnvironmentRef(run)?.revision)
    .filter((revision): revision is number => typeof revision === "number");
  if (revisions.length === 0) return null;
  const min = Math.min(...revisions);
  const max = Math.max(...revisions);
  return min === max ? `rev ${min}` : `rev ${min}–${max}`;
}

/**
 * The launch-time environment-drift 409 (`ENVIRONMENT_REVISION_CONFLICT`),
 * distinguished from a generic run failure so the retry-able cause is visible.
 * Returns the server's readable message ("Environment changed — retry the run.")
 * or `null` when this isn't a drift conflict.
 */
export function getEnvironmentConflictMessage(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code !== "ENVIRONMENT_REVISION_CONFLICT") return null;
  const message = error instanceof Error ? error.message : null;
  return message && message.length > 0
    ? message
    : "Environment changed since the suite was configured — retry the run.";
}

/**
 * Compute summary statistics for a list of iterations
 */
export function computeIterationSummary(items: EvalIteration[]) {
  const summary = {
    runs: items.length,
    passed: 0,
    failed: 0,
    cancelled: 0,
    pending: 0,
    tokens: 0,
    avgDuration: null as number | null,
  };

  let totalDuration = 0;
  let durationCount = 0;

  items.forEach((iteration) => {
    if (iteration.result === "passed") summary.passed += 1;
    else if (iteration.result === "failed") summary.failed += 1;
    else if (iteration.result === "cancelled") summary.cancelled += 1;
    // A timed-out iteration is terminal; without an explicit verdict it counts
    // as failed, not pending.
    else if (iteration.status === "timed_out") summary.failed += 1;
    else summary.pending += 1;

    summary.tokens += iteration.tokensUsed || 0;

    const startedAt = iteration.startedAt ?? iteration.createdAt;
    const completedAt = iteration.updatedAt ?? iteration.createdAt;
    if (startedAt && completedAt) {
      const duration = Math.max(completedAt - startedAt, 0);
      totalDuration += duration;
      durationCount += 1;
    }
  });

  if (durationCount > 0) {
    summary.avgDuration = totalDuration / durationCount;
  }

  return summary;
}

/**
 * Get the template key for a test case or config test
 * Falls back to a unique identifier if no explicit template key exists
 */
export function getTemplateKey(test: {
  testTemplateKey?: string;
  title?: string;
  query?: string;
  _id?: string;
}): string {
  if (test.testTemplateKey) return test.testTemplateKey;
  if (test._id) return `fallback:${test._id}`;
  return `fallback:${test.title}-${test.query}`;
}

export function aggregateSuite(
  _suite: EvalSuite,
  cases: EvalCase[],
  iterations: EvalIteration[]
): SuiteAggregate {
  // Backend already filters iterations by suite, so we use them directly
  const totals = iterations.reduce(
    (acc, it) => {
      const result = computeIterationResult(it);
      if (result === "pending") {
        acc.pending += 1;
      } else if (result === "passed") {
        acc.passed += 1;
      } else if (result === "failed") {
        acc.failed += 1;
      } else if (result === "cancelled") {
        acc.cancelled += 1;
      }
      acc.tokens += it.tokensUsed || 0;
      return acc;
    },
    { passed: 0, failed: 0, cancelled: 0, pending: 0, tokens: 0 }
  );

  const byCaseMap = new Map<string, SuiteAggregate["byCase"][number]>();
  for (const it of iterations) {
    const id = it.testCaseId;
    if (!id) continue;
    if (!byCaseMap.has(id)) {
      const c = cases.find((x) => x._id === id);
      const caseIterations = iterations.filter(
        (iter) => iter.testCaseId === id
      );
      const snapshots = caseIterations
        .map((iter) => iter.testCaseSnapshot)
        .filter((snapshot): snapshot is NonNullable<typeof snapshot> =>
          Boolean(snapshot?.model || snapshot?.provider)
        );
      // ONE representative iteration for the whole row. Title and model must be
      // read from the SAME iteration: sourcing the title from the first
      // iteration and the model from the last snapshot-bearing one shows a
      // renamed-then-rerun case under its old title beside its new model, a
      // pairing that never existed. Falls back to this iteration's own snapshot
      // when none carries a model, which is the title source either way.
      const representativeSnapshot =
        snapshots.length > 0
          ? snapshots[snapshots.length - 1]
          : it.testCaseSnapshot;
      // Key EVERY iteration, not only the snapshot-bearing ones. A case whose
      // iterations mix snapshot rows with pre-snapshot rows is still a mix: the
      // legacy rows are labelled from the case's CURRENT model, so keying only
      // the snapshots collapses `snapshotKeys` to one entry and stamps the whole
      // row with the snapshot's model while the counters below fold in
      // iterations that ran a different one. Each legacy row keys under the
      // fallback the label would use for it, so the two agree by construction.
      const modelKeys = new Set(
        caseIterations.map((iter) => {
          const snapshot = iter.testCaseSnapshot;
          return JSON.stringify(
            snapshot?.model || snapshot?.provider
              ? [snapshot.provider ?? "", snapshot.model ?? ""]
              : [c?.models?.[0]?.provider ?? "", c?.models?.[0]?.model ?? ""]
          );
        })
      );
      const hasMixedModels = modelKeys.size > 1;
      // Count total iterations for this test case
      const totalRuns = caseIterations.length;
      // THE ITERATION'S OWN SNAPSHOT WINS over the case's current definition.
      // A case's authored `models[0]` is what it would run TODAY; an
      // environment-backed run executes the environment's model instead, and a
      // later edit to either can move the authored list. Labelling history
      // from the live case therefore relabels finished runs with a model they
      // never used.
      //
      // The fallback is for pre-snapshot rows only: those predate environment
      // overrides, so their case's current model is the best available answer.
      //
      // SCOPE, unchanged by this: `byCase` is ONE ROW PER CASE, folding every
      // iteration handed to `aggregateSuite` — which, when the caller passes
      // iterations from more than one run, can span two models. The label then
      // comes from ONE representative iteration while the counts cover all of
      // them (the explicit `multiple` marker below is what keeps that from
      // reading as a claim). That is a pre-existing property of the shape,
      // not something the snapshot introduces (the live case's `models[0]` was
      // equally single-valued), and narrowing it means giving `byCase` a
      // run/model key — a change to the type every caller renders. Callers that
      // need per-model rows should aggregate one run at a time.
      byCaseMap.set(id, {
        testCaseId: id,
        title: representativeSnapshot?.title || c?.title || "Untitled",
        // A suite can legitimately contain the same case under multiple
        // environment models. Never label the combined counters with whichever
        // snapshot happened to be visited first; surface an explicit mixed
        // marker until the UI has a per-model aggregate view.
        provider: hasMixedModels
          ? "multiple"
          : representativeSnapshot?.provider || c?.models?.[0]?.provider || "",
        model: hasMixedModels
          ? "multiple"
          : representativeSnapshot?.model || c?.models?.[0]?.model || "",
        runs: totalRuns,
        passed: 0,
        failed: 0,
        cancelled: 0,
        tokens: 0,
      });
    }
    const entry = byCaseMap.get(id)!;
    const result = computeIterationResult(it);
    if (result === "pending") {
      // do not count pending/running
    } else if (result === "passed") {
      entry.passed += 1;
    } else if (result === "failed") {
      entry.failed += 1;
    } else if (result === "cancelled") {
      entry.cancelled += 1;
    }
    entry.tokens += it.tokensUsed || 0;
  }

  return {
    filteredIterations: iterations,
    totals,
    byCase: Array.from(byCaseMap.values()),
  };
}

/**
 * Sort Explore cases: failures first, then "warning" tier (pending/running, no result yet,
 * cancelled-only, or negative tests), then passes. Ties break by title.
 */
export function sortExploreCasesBySignal(
  cases: EvalCase[],
  aggregate: SuiteAggregate | null,
  iterations: EvalIteration[]
): EvalCase[] {
  const byCaseId = new Map(
    aggregate?.byCase.map((row) => [row.testCaseId, row]) ?? []
  );

  const latestIterationForCase = (
    testCaseId: string
  ): EvalIteration | undefined => {
    const forCase = iterations.filter((i) => i.testCaseId === testCaseId);
    if (forCase.length === 0) return undefined;
    return forCase.reduce((a, b) =>
      (a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? a : b
    );
  };

  const signalRank = (c: EvalCase): number => {
    const row = byCaseId.get(c._id);
    if (row && row.failed > 0) return 0;

    const latest = latestIterationForCase(c._id);
    if (!latest) return 1;

    const computed = computeIterationResult(latest);
    if (computed === "failed") return 0;
    if (computed === "pending") return 1;
    if (computed === "cancelled") return 1;
    if (c.isNegativeTest) return 1;
    return 2;
  };

  return [...cases].sort((a, b) => {
    const ra = signalRank(a);
    const rb = signalRank(b);
    if (ra !== rb) return ra - rb;
    return (a.title || "").localeCompare(b.title || "");
  });
}

/**
 * Centralized error handling for mutations
 */
export function handleMutationError(error: unknown, action: string) {
  console.error(`Failed to ${action}:`, error);
  toast.error(getBillingErrorMessage(error, `Failed to ${action}`));
}

/**
 * Centralized success toast
 */
export function handleMutationSuccess(message: string) {
  toast.success(message);
}

/**
 * Format a percentage
 */
export function formatPercentage(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * Format token count
 */
export function formatTokens(tokens: number): string {
  return tokens > 0 ? tokens.toLocaleString() : "—";
}

/**
 * Left `border-l-2` accents — parity with pre–#1602 `getIterationBorderColor` stripes
 * (`bg-success/50`, `bg-destructive/50`, `bg-warning/50`, …).
 */
export function evalStatusLeftBorderClasses(result: string): string {
  switch (result) {
    case RESULT_STATUS.PASSED:
      return "border-l-success/50";
    case RESULT_STATUS.FAILED:
      return "border-l-destructive/50";
    case RESULT_STATUS.PENDING:
    case "running":
      return "border-l-warning/50";
    case RESULT_STATUS.CANCELLED:
      return "border-l-muted";
    case "mixed":
    // Amber, alongside the other "no verdict" states: an unmeasurable run is
    // not a failing one.
    case "inconclusive":
      return "border-l-warning/50";
    default:
      return "border-l-muted-foreground/50";
  }
}

/**
 * Thin vertical strip fills — same opacity/hue as {@link evalStatusLeftBorderClasses}
 * (`bg-success/50`, `bg-destructive/50`, `bg-warning/50`) so nested rows match parent rails.
 */
export function evalStatusMiniBarClasses(result: string): string {
  switch (result) {
    case RESULT_STATUS.PASSED:
      return "bg-success/50";
    case RESULT_STATUS.FAILED:
      return "bg-destructive/50";
    case RESULT_STATUS.PENDING:
    case "running":
      return "bg-warning/50 animate-pulse";
    case RESULT_STATUS.CANCELLED:
      return "bg-muted-foreground/50";
    case "mixed":
      return "bg-warning/50";
    default:
      return "bg-muted-foreground/50";
  }
}

/** Left `border-l-*` for a suite overview row from `latestRun`. */
export function evalOverviewEntryLeftBorderClass(
  entry: EvalSuiteOverviewEntry
): string {
  const r = entry.latestRun;
  if (!r) return "border-l-transparent";
  if (r.status === "running" || r.status === "pending") {
    return evalStatusLeftBorderClasses(RESULT_STATUS.PENDING);
  }
  if (r.result === "passed") {
    return evalStatusLeftBorderClasses(RESULT_STATUS.PASSED);
  }
  if (r.result === "failed") {
    return evalStatusLeftBorderClasses(RESULT_STATUS.FAILED);
  }
  if (r.result === "inconclusive") {
    return evalStatusLeftBorderClasses("inconclusive");
  }
  return "border-l-muted-foreground/35";
}

export function evalOverviewEntryMiniBarClass(
  entry: EvalSuiteOverviewEntry
): string {
  const r = entry.latestRun;
  if (!r) return "bg-muted-foreground/25";
  if (r.status === "running" || r.status === "pending") {
    return "bg-warning/50 animate-pulse";
  }
  if (r.result === "passed") {
    return "bg-success/50";
  }
  if (r.result === "failed") return "bg-destructive/50";
  if (r.result === "inconclusive") return "bg-warning/50";
  return "bg-muted-foreground/50";
}

/**
 * Selected nested suite row — borders use the same `/50` rails as the parent
 * {@link evalOverviewEntryLeftBorderClass}.
 */
/** Selected nested row: inset ring + tint so left status border stays the outcome rail. */
export function evalOverviewEntrySelectedRowClass(
  entry: EvalSuiteOverviewEntry
): string {
  const r = entry.latestRun;
  if (!r) {
    return "bg-primary/10 ring-2 ring-primary/35 ring-inset";
  }
  if (r.status === "running" || r.status === "pending") {
    return "bg-warning/10 ring-2 ring-warning/40 ring-inset";
  }
  if (r.result === "passed") {
    return "bg-success/10 ring-2 ring-success/40 ring-inset";
  }
  if (r.result === "failed") {
    return "bg-destructive/10 ring-2 ring-destructive/35 ring-inset";
  }
  return "bg-primary/10 ring-2 ring-primary/35 ring-inset";
}

export function evalOverviewEntryOutcomeTitle(
  entry: EvalSuiteOverviewEntry
): string {
  const r = entry.latestRun;
  if (!r) return "No runs yet";
  if (r.status === "running" || r.status === "pending") {
    return "Run in progress";
  }
  if (r.result === "passed") return "Last run passed";
  if (r.result === "failed") return "Last run failed";
  // Deliberately not "failed": the last run did not measure enough to decide.
  if (r.result === "inconclusive") return "Last run inconclusive";
  return `Last run: ${r.status}`;
}

/** Short status label for compact list rows (sidebar). */
export function evalOverviewEntryLastRunStatusLabel(
  entry: EvalSuiteOverviewEntry
): string {
  const r = entry.latestRun;
  if (!r) return "No runs yet";
  if (r.status === "running" || r.status === "pending") return "Running";
  if (r.result === "passed") return "Passed";
  if (r.result === "inconclusive") return "Inconclusive";
  if (r.result === "failed" || r.status === "failed") return "Failed";
  if (r.result === "cancelled" || r.status === "cancelled") {
    return "Cancelled";
  }
  if (r.status === "completed") return "Completed";
  return "Unknown";
}

/** Tailwind classes for {@link evalOverviewEntryLastRunStatusLabel}. */
export function evalOverviewEntryLastRunStatusClass(
  entry: EvalSuiteOverviewEntry
): string {
  const r = entry.latestRun;
  if (!r) return "text-muted-foreground";
  if (r.status === "running" || r.status === "pending") {
    return "text-warning";
  }
  if (r.result === "passed") return "text-success";
  if (r.result === "inconclusive") return "text-warning";
  if (r.result === "failed" || r.status === "failed") {
    return "text-destructive";
  }
  if (r.result === "cancelled" || r.status === "cancelled") {
    return "text-muted-foreground";
  }
  return "text-muted-foreground";
}

/** Normalize API trend points (0–1 or 0–100) to 0–100 integers. */
export function toPercentEvalTrend(value: number): number {
  const normalized = value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, Math.round(normalized)));
}

export const SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS = 12;

/** When history is longer than this, show a “+N” badge with a tooltip of older points. */
export const SUITE_PASS_RATE_TREND_BADGE_THRESHOLD = 16;

export type SuitePassRateTrendDisplay = {
  percents: number[];
  olderHiddenCount: number;
  showOlderRunsBadge: boolean;
  summaryLabel: string;
  olderPercentsTooltip: string | null;
};

/**
 * Prepare pass-rate trend for sidebar sparklines: last N segments, optional overflow badge, summary text.
 */
export function formatSuitePassRateTrendForDisplay(
  rawTrend: number[] | undefined | null
): SuitePassRateTrendDisplay | null {
  if (!rawTrend?.length) return null;
  const len = rawTrend.length;
  const slice = rawTrend.slice(-SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS);
  const percents = slice.map(toPercentEvalTrend);
  const olderHiddenCount = Math.max(
    0,
    len - SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS
  );
  const showOlderRunsBadge = len > SUITE_PASS_RATE_TREND_BADGE_THRESHOLD;
  let good = 0;
  for (const p of percents) {
    if (p >= 80) good += 1;
  }
  const worst = Math.min(...percents);
  const summaryLabel =
    percents.length >= 3
      ? `${good}/${percents.length} ≥80% · min ${worst}%`
      : "";
  const olderSlice =
    olderHiddenCount > 0
      ? rawTrend
          .slice(0, len - SUITE_PASS_RATE_TREND_VISIBLE_SEGMENTS)
          .map(toPercentEvalTrend)
      : [];
  const olderPercentsTooltip =
    olderSlice.length > 0
      ? `Earlier runs (pass rate %): ${olderSlice.join(", ")}`
      : null;
  return {
    percents,
    olderHiddenCount,
    showOlderRunsBadge,
    summaryLabel,
    olderPercentsTooltip,
  };
}

/**
 * Background class for legacy `w-1` strips (pre–#1602 iteration rows).
 */
export function getIterationBorderColor(result: string): string {
  switch (result) {
    case RESULT_STATUS.PASSED:
      return "bg-success/50";
    case RESULT_STATUS.FAILED:
      return "bg-destructive/50";
    case RESULT_STATUS.CANCELLED:
      return "bg-muted";
    case RESULT_STATUS.PENDING:
    case "running":
      return "bg-warning/50";
    default:
      return "bg-muted-foreground/50";
  }
}

/**
 * Get status dot color
 */
export function getStatusDotColor(result: string, status?: string): string {
  if (result === RESULT_STATUS.PASSED) return "bg-success";
  if (result === RESULT_STATUS.FAILED) return "bg-destructive";
  if (result === RESULT_STATUS.CANCELLED) return "bg-muted-foreground";
  if (result === RESULT_STATUS.PENDING || status === "pending")
    return "bg-warning";
  if (status === "running") return "bg-warning";
  return "bg-muted-foreground";
}

/**
 * Formatters object for convenient access
 */
export const formatters = {
  time: formatTime,
  duration: formatDuration,
  runId: formatRunId,
  percentage: formatPercentage,
  tokens: formatTokens,
} as const;

/**
 * Order runs for commit drilldown: failed first, then running/pending, then
 * inconclusive, then passed, then other (same ordering as the former in-panel
 * suite list, with the undecided runs ahead of the green ones because they are
 * the ones still asking for attention).
 */
export function orderCommitGroupRunsByOutcome(
  runs: EvalSuiteRun[]
): EvalSuiteRun[] {
  const failed: EvalSuiteRun[] = [];
  const running: EvalSuiteRun[] = [];
  const inconclusive: EvalSuiteRun[] = [];
  const passed: EvalSuiteRun[] = [];
  const notRun: EvalSuiteRun[] = [];

  for (const run of runs) {
    if (run.status === "running" || run.status === "pending") {
      running.push(run);
    } else if (run.result === "failed") {
      failed.push(run);
    } else if (run.result === "inconclusive") {
      inconclusive.push(run);
    } else if (run.result === "passed") {
      passed.push(run);
    } else {
      notRun.push(run);
    }
  }
  return [...failed, ...running, ...inconclusive, ...passed, ...notRun];
}

/**
 * Metric-label source for a run: CI ('sdk') runs report "Pass Rate"
 * (per-case summary), everything else — ui/api/schedule — "Accuracy"
 * (per-iteration). Legacy runs without `source` fall back to the suite's
 * creation provenance.
 */
export function getRunMetricSource(
  run: { source?: EvalSuiteRun["source"] } | null | undefined,
  suiteSource?: "ui" | "sdk"
): "ui" | "sdk" {
  return (run?.source ?? suiteSource) === "sdk" ? "sdk" : "ui";
}

/**
 * Suite-scoped views (hero stats, runs-table header, chart grid) label by
 * the newest run's source — a mixed suite reads as whatever it did last.
 */
export function getLatestRunMetricSource(
  runs: EvalSuiteRun[],
  suiteSource?: "ui" | "sdk"
): "ui" | "sdk" {
  let latest: EvalSuiteRun | null = null;
  let latestTs = -1;
  for (const run of runs) {
    const ts = run.completedAt ?? run.createdAt ?? 0;
    if (ts > latestTs) {
      latest = run;
      latestTs = ts;
    }
  }
  return getRunMetricSource(latest, suiteSource);
}

/**
 * Flatten recentRuns across all suites and group by commitSha.
 * Runs without a commitSha go into a "manual" group.
 */
export function groupRunsByCommit(
  overview: EvalSuiteOverviewEntry[]
): CommitGroup[] {
  const buckets = new Map<
    string,
    { runs: EvalSuiteRun[]; suiteMap: Map<string, string> }
  >();

  for (const entry of overview) {
    for (const run of entry.recentRuns) {
      const sha = run.ciMetadata?.commitSha?.trim() || "";
      // Each manual run (no commit SHA) gets its own group keyed by run ID
      const key = sha || `__manual__${run._id}`;
      if (!buckets.has(key)) {
        buckets.set(key, { runs: [], suiteMap: new Map() });
      }
      const bucket = buckets.get(key)!;
      bucket.runs.push(run);
      bucket.suiteMap.set(entry.suite._id, entry.suite.name);
    }
  }

  const groups: CommitGroup[] = [];
  for (const [key, { runs, suiteMap }] of buckets) {
    const isManual = key.startsWith("__manual__");
    const summary = {
      total: runs.length,
      passed: 0,
      failed: 0,
      running: 0,
      inconclusive: 0,
    };
    let latestTimestamp = 0;
    let branch: string | null = null;

    for (const run of runs) {
      const ts = run.completedAt ?? run.createdAt;
      if (ts > latestTimestamp) latestTimestamp = ts;
      if (!branch && run.ciMetadata?.branch) branch = run.ciMetadata.branch;
      if (run.status === "running" || run.status === "pending")
        summary.running++;
      else if (run.result === "passed") summary.passed++;
      else if (run.result === "failed") summary.failed++;
      else if (run.result === "inconclusive") summary.inconclusive++;
    }

    let status: CommitGroup["status"];
    if (summary.running > 0) status = "running";
    else if (summary.failed > 0 && summary.passed > 0) status = "mixed";
    else if (summary.failed > 0) status = "failed";
    // Nothing failed AND nothing passed, but something was undecided: the
    // commit has no verdict. Falling through to `passed` here is how an
    // unmeasurable commit gets a green rail it never earned.
    else if (summary.inconclusive > 0 && summary.passed === 0)
      status = "inconclusive";
    else status = "passed";

    // For manual runs, use a unique ID so each gets its own page
    const manualId = isManual ? key.replace("__manual__", "manual-") : null;

    groups.push({
      commitSha: isManual ? manualId! : key,
      shortSha: isManual ? "Manual" : key.slice(0, 7),
      branch: isManual ? null : branch,
      timestamp: latestTimestamp,
      status,
      runs,
      suiteMap,
      summary,
    });
  }

  // Sort by most recent first, manual always last
  groups.sort((a, b) => {
    if (a.commitSha.startsWith("manual-")) return 1;
    if (b.commitSha.startsWith("manual-")) return -1;
    return b.timestamp - a.timestamp;
  });

  return groups;
}

/**
 * Format relative time for sidebar display
 */
export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "No runs yet";
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Group overview entries by tag and compute aggregated stats per tag.
 */
export function groupSuitesByTag(
  overview: EvalSuiteOverviewEntry[]
): TagGroupAggregate[] {
  const buckets = new Map<string, EvalSuiteOverviewEntry[]>();

  for (const entry of overview) {
    const tags = entry.suite.tags;
    if (!tags || tags.length === 0) {
      const bucket = buckets.get("Untagged") ?? [];
      bucket.push(entry);
      buckets.set("Untagged", bucket);
    } else {
      for (const tag of tags) {
        const bucket = buckets.get(tag) ?? [];
        bucket.push(entry);
        buckets.set(tag, bucket);
      }
    }
  }

  const groups: TagGroupAggregate[] = [];
  for (const [tag, entries] of buckets) {
    const totals = { passed: 0, failed: 0, runs: 0 };
    for (const e of entries) {
      totals.passed += e.totals.passed;
      totals.failed += e.totals.failed;
      totals.runs += e.totals.runs;
    }
    const total = totals.passed + totals.failed;
    groups.push({
      tag,
      suiteCount: entries.length,
      totals,
      passRate: total > 0 ? Math.round((totals.passed / total) * 100) : 0,
      entries,
    });
  }

  // Sort alphabetically, "Untagged" last
  groups.sort((a, b) => {
    if (a.tag === "Untagged") return 1;
    if (b.tag === "Untagged") return -1;
    return a.tag.localeCompare(b.tag);
  });

  return groups;
}

/**
 * Compute a percentile from a numeric series using linear interpolation.
 * Returns `null` for empty input. `p` is 0..1 (e.g. 0.5, 0.95).
 *
 * Exposed for unit tests; prefer the higher-level `iterationLatencyP50` /
 * `iterationLatencyP95` / `iterationTokensP50` / `iterationTokensP95`
 * helpers below for inspector code paths.
 */
export function percentile(values: number[], p: number): number | null {
  if (!Array.isArray(values) || values.length === 0) return null;
  // Sort first so the p<=0 / p>=1 short-circuits don't spread the whole
  // array into Math.min / Math.max (blows up past ~100k args).
  const sorted = [...values].sort((a, b) => a - b);
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const w = rank - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function iterationDurationMs(it: EvalIteration): number | null {
  const start = it.startedAt;
  const end = it.updatedAt;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (end < start) return null;
  return end - start;
}

/** p50 of per-iteration durations (ms) across `completed` iterations. */
export function iterationLatencyP50(items: EvalIteration[]): number | null {
  const vals = items
    .filter((it) => it.status === "completed")
    .map(iterationDurationMs)
    .filter((v): v is number => v !== null);
  return percentile(vals, 0.5);
}

/** p95 of per-iteration durations (ms) across `completed` iterations. */
export function iterationLatencyP95(items: EvalIteration[]): number | null {
  const vals = items
    .filter((it) => it.status === "completed")
    .map(iterationDurationMs)
    .filter((v): v is number => v !== null);
  return percentile(vals, 0.95);
}

/** p50 of `tokensUsed` across `completed` iterations. */
export function iterationTokensP50(items: EvalIteration[]): number | null {
  const vals = items
    .filter((it) => it.status === "completed")
    .map((it) => it.tokensUsed)
    .filter((v): v is number => typeof v === "number");
  return percentile(vals, 0.5);
}

/** p95 of `tokensUsed` across `completed` iterations. */
export function iterationTokensP95(items: EvalIteration[]): number | null {
  const vals = items
    .filter((it) => it.status === "completed")
    .map((it) => it.tokensUsed)
    .filter((v): v is number => typeof v === "number");
  return percentile(vals, 0.95);
}

/** Total ordering on runs: `runNumber` primary, `createdAt` as tiebreaker. */
export function compareRunsBySequence(
  a: EvalSuiteRun,
  b: EvalSuiteRun
): number {
  return a.runNumber - b.runNumber || a.createdAt - b.createdAt;
}

/** Highest `runNumber` among completed runs (Convex `listTestSuiteRuns` is newest-first but we still sort defensively). */
export function pickLatestCompletedRun(
  runs: EvalSuiteRun[]
): EvalSuiteRun | null {
  const completed = runs.filter((r) => r.status === "completed");
  if (completed.length === 0) {
    return null;
  }
  return completed.reduce((best, r) =>
    r.runNumber > best.runNumber ? r : best
  );
}

/**
 * Does anything about this suite pin a sandbox image for its NEXT run?
 *
 * Two sources, both checked: the suite's own
 * `environment.computerEnvironmentId` (the migration-era override) and any
 * ATTACHED project environment's pin — env-backed suites resolve their image
 * server-side at launch, so checking only the suite field would miss exactly
 * the suites that increasingly carry the pin. Historical runs' frozen
 * snapshot pins are deliberately NOT consulted here: they gate REPLAY of that
 * run, not fresh runs (see `RunDetailPlaygroundActions`).
 */
export function evalSuitePinsSandboxImage(
  suite: Pick<EvalSuite, "environment" | "environmentIds">,
  attachedEnvironments:
    | Array<{ environmentId: string; computerEnvironmentId?: string | null }>
    | undefined
): boolean {
  if (suite.environment?.computerEnvironmentId) return true;
  return (suite.environmentIds ?? []).some((environmentId) =>
    Boolean(
      (attachedEnvironments ?? []).find(
        (environment) => environment.environmentId === environmentId
      )?.computerEnvironmentId
    )
  );
}
