/**
 * Starting a hosted conformance run, once, for the public `/api/v1` surface.
 *
 * Directory readiness keeps its own helper because the two products create
 * the row in different places: readiness mutates first and detaches a
 * worker, conformance starts the row INSIDE `executePersistedConformanceRun`.
 * The receipt still has to leave before suites finish, so this helper races
 * `onRunStarted` against an executor rejection and then detaches.
 *
 * THE TARGET COMES FROM THE SAVED SERVER the caller already authorized,
 * never from a request body. A body field that could name a host would turn
 * this surface into an authenticated fetch primitive.
 */

import type { ConvexHttpClient } from "convex/browser";
import type { McpProtocolVersion } from "@mcpjam/sdk";
import type { RunLauncher } from "../../utils/launch-context.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { toHttpConfig } from "../web/auth.js";
import { WEB_CALL_TIMEOUT_MS } from "../../config.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
  assertAllowedHostedTargetUrl,
} from "../../utils/hosted-egress-guard.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { executePersistedConformanceRun } from "../../services/conformance-run-executor.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import {
  releaseConformanceStartSlot,
  takeConformanceStartSlot,
} from "../../middleware/conformance-run-rate-limit.js";
import {
  readConformanceRunSettings,
  suiteConfigsForRun,
  suitesKeptBySettings,
  type ConformanceSettingsMode,
  type ConformanceSettingsSource,
} from "../../services/conformance-run-settings.js";
import { createConformanceFetch } from "./conformance.js";
import { pageFailingChecks } from "./conformance-check.js";

export const HOSTED_CONFORMANCE_SUITES = ["protocol", "apps", "tasks"] as const;
export type HostedConformanceSuite = (typeof HOSTED_CONFORMANCE_SUITES)[number];

const DEFAULT_SUITES: HostedConformanceSuite[] = [
  "protocol",
  "apps",
  "tasks",
];

export const CONFORMANCE_REPORT_CASE_CAP = 50;
const REPORT_FETCH_TIMEOUT_MS = 30_000;
const STORED_REPORT_UNREADABLE =
  "The conformance report could not be read from storage.";

function storedReportUnreadable(): never {
  // v1 derives HTTP status from the public code (`INTERNAL_ERROR` → 500).
  // Storage is an upstream hop, so `SERVER_UNREACHABLE` is what keeps the
  // documented 502.
  throw new WebRouteError(
    502,
    ErrorCode.SERVER_UNREACHABLE,
    STORED_REPORT_UNREADABLE,
  );
}

/** The shape `authorizeServer` hands back, narrowed to what a start needs. */
export interface AuthorizedConformanceServer {
  serverConfig: {
    transportType?: string;
    url?: string;
    headers?: Record<string, string>;
    useOAuth?: boolean;
  };
  oauthAccessToken?: string | null;
}

export interface StartHostedConformanceRunInput {
  convexToken: string;
  projectId: string;
  serverId: string;
  authorized: AuthorizedConformanceServer;
  suites?: HostedConformanceSuite[];
  idempotencyKey?: string;
  protocolVersion?: McpProtocolVersion;
  engineVersion?: string;
  /** The server's saved settings (the default), or none. */
  settings?: ConformanceSettingsMode;
  /** The client's declared launcher, from the launch headers. */
  launcher?: RunLauncher;
  /** Whose start budget a start spends. Absent: no per-caller limit. */
  startLimitKey?: string;
  translateError: (error: unknown) => Error;
}

export interface HostedConformanceReceipt {
  runId: string;
  projectId: string;
  serverId: string;
  status: string;
  deduped: boolean;
  requestedSuites: HostedConformanceSuite[];
  /** Absent for a retry of a run started before runs recorded it. */
  settingsSource?: ConformanceSettingsSource;
}

/** The fields of a stored run a retry's receipt is built from. */
type StoredRunForReceipt = {
  _id: string;
  status: string;
  requestedSuites: HostedConformanceSuite[];
  settingsSource?: ConformanceSettingsSource | null;
};

export type ConformanceReportCheck = {
  suiteKind: string;
  id: string;
  title: string;
  groupId: string;
  status: string;
  pending: boolean;
  skipReason?: string;
  error?: string;
};

export type ConformanceReportProfile = {
  suiteKind: string;
  profileId: string | null;
  profileVersion: string | null;
  pendingCheckIds: string[];
};

export type ConformanceReportProjection = {
  runId: string;
  status: string;
  outcome: string | null;
  score: number | null;
  pending: number;
  checks: ConformanceReportCheck[];
  totalCases: number;
  /** Failed + could-not-run count, the denominator behind `truncated`. */
  totalFailingCases: number;
  /** More failing checks follow this page. */
  truncated: boolean;
  /** The next page's cursor; a running run has none. */
  nextCursor?: string;
  profiles: ConformanceReportProfile[];
};

async function assertConformanceTarget(
  rawUrl: string,
  label: string,
): Promise<void> {
  try {
    await assertAllowedHostedTargetUrl(rawUrl, label);
  } catch (error) {
    if (error instanceof BlockedEgressTargetError) {
      throw new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    if (error instanceof EgressResolutionError) {
      throw new WebRouteError(503, ErrorCode.SERVER_UNREACHABLE, error.message);
    }
    throw error;
  }
}

/**
 * Create the run (inside the executor) and return a receipt the moment the
 * id exists. Suites keep running in THIS process after the promise settles.
 */
export async function startHostedConformanceRun(
  input: StartHostedConformanceRunInput,
): Promise<HostedConformanceReceipt> {
  const config = input.authorized.serverConfig;
  if (config.transportType !== "http" || !config.url) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Conformance grades HTTP connectors; this server uses a different transport.",
    );
  }
  const convex = createConvexClient(input.convexToken);
  const externalRunId = input.idempotencyKey
    ? `api:${input.projectId}:${input.serverId}:${input.idempotencyKey}`
    : undefined;
  // A retry answers with the run its key already started, as that run was
  // decided: its suites and settings, not what the saved settings say now.
  if (externalRunId) {
    let existing: StoredRunForReceipt | null;
    try {
      existing = (await convex.query(
        "conformanceRuns:getRunByExternalRunId" as never,
        { projectId: input.projectId, externalRunId } as never,
      )) as StoredRunForReceipt | null;
    } catch (error) {
      throw input.translateError(error);
    }
    if (existing) {
      return {
        runId: String(existing._id),
        projectId: input.projectId,
        serverId: input.serverId,
        status: existing.status,
        deduped: true,
        requestedSuites: existing.requestedSuites,
        ...(existing.settingsSource
          ? { settingsSource: existing.settingsSource }
          : {}),
      };
    }
  }
  await assertConformanceTarget(config.url, "Server URL");

  const httpConfig = toHttpConfig(
    input.authorized as never,
    WEB_CALL_TIMEOUT_MS,
    input.authorized.oauthAccessToken ?? undefined,
  );
  const server = {
    ...httpConfig,
    fetchFn: createConformanceFetch("MCP server"),
    baseFetch: createConformanceFetch("MCP server"),
  };
  const settings = await readConformanceRunSettings(convex, {
    projectId: input.projectId,
    serverId: input.serverId,
    mode: input.settings ?? "saved",
  }).catch((error: unknown) => {
    throw input.translateError(error);
  });
  // Resolved before the run exists, as the app does before Run: which suites
  // have checks to run, and which tools they call, depend on the version.
  const suiteConfigs = await suiteConfigsForRun(
    settings,
    server,
    input.protocolVersion,
  );
  const requestedSuites = suitesKeptBySettings(
    input.suites && input.suites.length > 0 ? input.suites : DEFAULT_SUITES,
    settings,
    suiteConfigs.protocolVersion,
  );
  if (requestedSuites.length === 0) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      'This server\'s saved conformance settings leave out every suite you asked for. Ask for a suite they select, or start the run with settings set to "none".',
    );
  }

  // Spent only by a start that goes on to dial the server: a refused request
  // or a retry answered above costs nothing.
  const limitKey = input.startLimitKey;
  const limited =
    limitKey === undefined ? null : takeConformanceStartSlot(limitKey);
  if (limited) {
    throw new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      `You started 30 conformance runs in the last 10 minutes. Try again in ${limited.retryAfterSeconds} seconds.`,
    ).withHeaders({ "Retry-After": String(limited.retryAfterSeconds) });
  }
  const giveBackSlot = () => {
    if (limitKey !== undefined) releaseConformanceStartSlot(limitKey);
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    void executePersistedConformanceRun({
      convexToken: input.convexToken,
      projectId: input.projectId,
      server,
      suites: requestedSuites,
      source: "api",
      target: { kind: "server", serverId: input.serverId },
      protocolVersion: input.protocolVersion,
      engineVersion: input.engineVersion,
      actorLabel: "MCPJam API",
      settings,
      suiteConfigs,
      ...(input.launcher ? { launcher: input.launcher } : {}),
      runTimeoutSeconds: settings.runTimeoutSeconds,
      externalRunId,
      onRunStarted: async (runId, meta) => {
        if (settled) return;
        settled = true;
        // A start that raced a retry to the same key dials nothing.
        if (meta?.reused) giveBackSlot();
        resolve({
          runId,
          projectId: input.projectId,
          serverId: input.serverId,
          status: meta?.status ?? "queued",
          deduped: meta?.reused === true,
          requestedSuites,
          settingsSource: settings.source,
        });
      },
    }).catch((error) => {
      if (!settled) {
        settled = true;
        // Refused before its run existed, so it dialled nothing.
        giveBackSlot();
        reject(input.translateError(error));
        return;
      }
      reportRouteFailure(
        "[conformance] detached hosted run escaped its own handler",
        error,
        {
          source: "conformance.hosted_run",
          hop: "mcpjam_internal",
          context: { projectId: input.projectId, serverId: input.serverId },
        },
      );
    });
  });
}

function isStoredReportUrl(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function toConformanceRunDto(
  run: Record<string, any>,
  options: { projectId: string; reportUrl?: (runId: string) => string },
) {
  const id = String(run.id ?? run._id ?? "");
  const reports = Array.isArray(run.reports) ? run.reports : [];
  const hasReport = reports.some((report: { reportUrl?: unknown }) =>
    isStoredReportUrl(report.reportUrl),
  );
  // A STORED REPORT, not a terminal status. A run can reach `timed_out` or
  // `cancelled` having stored nothing, and `/report` answers those 404 — so
  // offering the link on status alone advertises an address that is known in
  // advance to fail. Absent is the honest rendering of "there is nothing to
  // fetch".
  const reportUrl =
    hasReport && options.reportUrl && id ? options.reportUrl(id) : null;
  return {
    id,
    projectId: run.projectId ?? options.projectId,
    serverId: run.serverId ?? null,
    source: run.source ?? null,
    verification: run.verification ?? null,
    status: run.status,
    outcome: run.outcome ?? null,
    incompleteReason: run.incompleteReason ?? null,
    score: run.score ?? null,
    applicable: run.applicable ?? 0,
    passed: run.passed ?? 0,
    failed: run.failed ?? 0,
    couldNotRun: run.couldNotRun ?? 0,
    notApplicable: run.notApplicable ?? 0,
    pending: run.pending ?? 0,
    advisoryCount: run.advisoryCount ?? 0,
    requestedSuites: run.requestedSuites ?? [],
    /** Recorded by backends that store it; null for runs started before. */
    settingsSource: run.settingsSource ?? null,
    launcher: run.launcher ?? null,
    attribution: run.attribution ?? null,
    protocolVersion: run.protocolVersion ?? null,
    engineVersion: run.engineVersion ?? null,
    createdAt: run.createdAt,
    completedAt: run.completedAt ?? null,
    durationMs: run.durationMs ?? null,
    reports: reports.map((report: Record<string, any>) => ({
      suiteKind: report.suiteKind,
      status: report.status,
      outcome: report.outcome ?? null,
      score: report.score ?? null,
      pending: report.pending ?? 0,
      profileId: report.profileId ?? null,
      profileVersion: report.profileVersion ?? null,
      hasReport: isStoredReportUrl(report.reportUrl),
    })),
    reportUrl,
  };
}

function caseRank(check: { status?: string; skipReason?: string }): number {
  if (check.status === "failed") return 0;
  if (check.status === "skipped" && check.skipReason === "could-not-run") {
    return 1;
  }
  return 2;
}

function isFailingCheck(check: {
  status?: string;
  skipReason?: string;
}): boolean {
  return (
    check.status === "failed" ||
    (check.status === "skipped" && check.skipReason === "could-not-run")
  );
}

function flattenCases(
  suiteKind: string,
  report: unknown,
): ConformanceReportCheck[] {
  if (!report || typeof report !== "object") return [];
  const groups = (report as { groups?: unknown }).groups;
  if (!Array.isArray(groups)) return [];
  const out: ConformanceReportCheck[] = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    const groupId = String(
      (group as { id?: unknown }).id ??
        (group as { name?: unknown }).name ??
        "",
    );
    const cases = (group as { cases?: unknown }).cases;
    if (!Array.isArray(cases)) continue;
    for (const entry of cases) {
      if (!entry || typeof entry !== "object") continue;
      const rec = entry as Record<string, unknown>;
      out.push({
        suiteKind,
        id: String(rec.id ?? ""),
        title: String(rec.title ?? rec.id ?? ""),
        groupId,
        status: String(rec.status ?? ""),
        pending: rec.pending === true,
        ...(typeof rec.skipReason === "string"
          ? { skipReason: rec.skipReason }
          : {}),
        ...(typeof rec.error === "string" ? { error: rec.error } : {}),
      });
    }
  }
  return out;
}

function profileFromReport(
  suiteKind: string,
  report: unknown,
): ConformanceReportProfile {
  const profile =
    report && typeof report === "object"
      ? (report as { profile?: Record<string, unknown> }).profile
      : undefined;
  const pendingCheckIds = Array.isArray(profile?.pendingCheckIds)
    ? profile.pendingCheckIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  return {
    suiteKind,
    profileId: typeof profile?.profileId === "string" ? profile.profileId : null,
    profileVersion:
      typeof profile?.profileVersion === "string"
        ? profile.profileVersion
        : null,
    pendingCheckIds,
  };
}

export function projectConformanceReports(
  run: Record<string, any>,
  suiteReports: { suiteKind: string; report: unknown }[],
  cursor?: string,
): ConformanceReportProjection {
  const all: ConformanceReportCheck[] = [];
  const profiles: ConformanceReportProfile[] = [];
  for (const suite of suiteReports) {
    all.push(...flattenCases(suite.suiteKind, suite.report));
    profiles.push(profileFromReport(suite.suiteKind, suite.report));
  }
  const failing = all
    .filter(isFailingCheck)
    .sort((a, b) => caseRank(a) - caseRank(b));
  const runId = String(run.id ?? run._id ?? "");
  const status = String(run.status ?? "");
  const page = pageFailingChecks(
    { id: runId, status },
    failing,
    CONFORMANCE_REPORT_CASE_CAP,
    cursor,
  );
  return {
    runId,
    status,
    outcome: run.outcome ?? null,
    score: run.score ?? null,
    pending: run.pending ?? 0,
    checks: page.checks,
    totalCases: all.length,
    totalFailingCases: failing.length,
    truncated: page.more,
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    profiles,
  };
}

export async function fetchSuiteReports(
  reports: { suiteKind: string; reportUrl?: string | null }[],
): Promise<{ suiteKind: string; report: unknown }[]> {
  const withUrl = reports.filter(
    (report): report is { suiteKind: string; reportUrl: string } =>
      isStoredReportUrl(report.reportUrl),
  );
  const out: { suiteKind: string; report: unknown }[] = [];
  for (const report of withUrl) {
    let response: Response;
    try {
      response = await fetch(report.reportUrl, {
        signal: AbortSignal.timeout(REPORT_FETCH_TIMEOUT_MS),
      });
    } catch {
      storedReportUnreadable();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 404) {
        throw new WebRouteError(
          404,
          ErrorCode.NOT_FOUND,
          "This conformance run's report is no longer stored.",
        );
      }
      storedReportUnreadable();
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      storedReportUnreadable();
    }
    out.push({ suiteKind: report.suiteKind, report: body });
  }
  return out;
}
