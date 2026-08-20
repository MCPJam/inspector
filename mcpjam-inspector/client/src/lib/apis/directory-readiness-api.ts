/**
 * The /conformance page's two ways to grade a server against a directory.
 *
 * ## Why this is not in `mcp-conformance-api.ts`
 *
 * Every suite beside it is one request that returns a verdict. Readiness is
 * two different shapes wearing one name:
 *
 *   LOCAL   — a synchronous call that grades and answers inline. Free, no run
 *             row, no persistence, and structurally unable to spend: the route
 *             has no observations flag at all.
 *   HOSTED  — `202` with a receipt, then polling, then a separate report
 *             fetch, with a cancel that stops traffic to somebody else's
 *             server. It runs on `/api/v1` rather than `/api/web`, because
 *             that is where the durable run lifecycle lives.
 *
 * `runByMode` cannot express that: its two branches are supposed to be the
 * same operation against different backends, and here one returns a result
 * while the other returns a receipt. So the mode fork is explicit, and the
 * hook above normalizes the two into one state machine.
 *
 * ## Why `authFetch` and not `webPost`
 *
 * `webPost` speaks the `/api/web` envelope and ingests hosted RPC logs into
 * the traffic-log store. The v1 envelope is a different contract, so the
 * calls here go through `authFetch` directly. The visible cost is that
 * readiness traffic does NOT appear in the traffic log where the other suites'
 * does — a real gap, accepted rather than papered over, because faking the web
 * envelope to get log ingestion would make readiness lie about which API it
 * used.
 */

import type {
  ClaudeReadinessResult,
  OpenAIReadinessResult,
  OpenAISubmissionMode,
} from "@mcpjam/sdk/browser";
import { authFetch } from "@/lib/session-token";
import { localPost } from "@/lib/apis/local-post";
import {
  getHostedProjectId,
  resolveHostedServerId,
  tryResolveProjectServer,
} from "@/lib/apis/web/context";

export type DirectoryReadinessPublisher = "claude" | "openai";

export type DirectoryReadinessResult =
  | ClaudeReadinessResult
  | OpenAIReadinessResult;

/**
 * The submission shapes a HOSTED run can grade.
 *
 * Two of OpenAI's four carry a package, and there is no upload for it — those
 * only ever run on the CLI. Offering them here and failing at the API would
 * teach a submitter that readiness is broken rather than that they are on the
 * wrong surface.
 */
export const HOSTED_SUBMISSION_MODES = [
  "mcp-only",
  "mcp-imported-skills",
] as const satisfies readonly OpenAISubmissionMode[];

export type HostedSubmissionMode = (typeof HOSTED_SUBMISSION_MODES)[number];

export type ReadinessRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** The three axes, exactly as the row carries them. */
export interface ReadinessRun {
  id: string;
  readinessKind: DirectoryReadinessPublisher;
  serverId: string | null;
  serverUrl: string;
  submissionMode: OpenAISubmissionMode | null;
  /** Whether the RUN finished. Not whether it graded well. */
  status: ReadinessRunStatus;
  /** The GRADE. `completed` + `not-ready` is a finished run that failed. */
  overallStatus: "ready" | "not-ready" | "incomplete" | null;
  lanes: Array<{
    lane: string;
    status: "ready" | "not-ready" | "incomplete";
    evaluated: number;
    notEvaluated: number;
    notApplicable: number;
    missingInputs: string[];
  }>;
  stages: Array<{
    stage: string;
    status: "ready" | "not-ready" | "incomplete";
    lanes: string[];
  }>;
  attemptCount: number;
  terminalReason: string | null;
  errorMessage: string | null;
  policySnapshotDate: string | null;
  engineVersion: string | null;
  includeLlmObservations: boolean;
  /** Independent of `status`: a refused observation still completes the run. */
  llmObservations: {
    status:
      | "not-requested"
      | "pending"
      | "completed"
      | "billing-blocked"
      | "provider-failed"
      | "invalid-output";
    reason?: string;
    detail?: string;
  };
  hasReport: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ReadinessRunReceipt {
  runId: string;
  projectId: string;
  serverId: string;
  readinessKind: DirectoryReadinessPublisher;
  status: ReadinessRunStatus;
  /** True when an idempotency replay returned a run that already existed. */
  deduped: boolean;
  includeLlmObservations: boolean;
}

/** Terminal states: nothing about this run will change again. */
export function isTerminalRunStatus(status: ReadinessRunStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/** True when the app can reach the hosted run lifecycle for this server. */
export function canRunHostedReadiness(serverNameOrId: string): boolean {
  return tryResolveProjectServer(serverNameOrId) !== null;
}

async function v1Json<T>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  const response = await authFetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (!response.ok) {
    // The v1 envelope reports `{error: {code, message}}`; anything else is a
    // proxy or a network edge, and the status is the only honest thing to say.
    const message =
      (parsed as { error?: { message?: string } } | null)?.error?.message ??
      `Request failed (${response.status})`;
    throw new Error(message);
  }
  return parsed as T;
}

// ── Local: synchronous, free, no run row ────────────────────────────────

export async function runLocalReadiness(
  publisher: DirectoryReadinessPublisher,
  serverNameOrId: string,
  options?: { submissionMode?: OpenAISubmissionMode },
): Promise<{ success: boolean; result: DirectoryReadinessResult }> {
  return localPost(`/api/mcp/conformance/readiness/${publisher}`, {
    serverId: serverNameOrId,
    ...(options?.submissionMode
      ? { submissionMode: options.submissionMode }
      : {}),
  });
}

// ── Hosted: start, poll, cancel, report ─────────────────────────────────

export async function startHostedReadiness(
  publisher: DirectoryReadinessPublisher,
  serverNameOrId: string,
  options: {
    submissionMode?: HostedSubmissionMode;
    includeLlmObservations?: boolean;
    idempotencyKey?: string;
  } = {},
): Promise<ReadinessRunReceipt> {
  const projectId = getHostedProjectId();
  const serverId = resolveHostedServerId(serverNameOrId);

  // FIELDS PICKED, NEVER SPREAD. The start schema is a `strictObject`, so an
  // unknown key is a 400 rather than an ignored extra — and a rejected start
  // never reaches its idempotency key, so the retry would dedupe against
  // nothing and start a second run against somebody's server.
  const body: Record<string, unknown> = {};
  if (options.idempotencyKey) body.idempotencyKey = options.idempotencyKey;
  if (options.includeLlmObservations === true) {
    body.includeLlmObservations = true;
  }
  if (publisher === "openai") {
    if (!options.submissionMode) {
      throw new Error(
        "An OpenAI readiness run needs a declared submission mode.",
      );
    }
    body.submissionMode = options.submissionMode;
  }

  return v1Json<ReadinessRunReceipt>(
    `/api/v1/projects/${encodeURIComponent(
      projectId,
    )}/servers/${encodeURIComponent(serverId)}/readiness-runs/${publisher}`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function getHostedReadinessRun(
  runId: string,
  signal?: AbortSignal,
): Promise<ReadinessRun> {
  const projectId = getHostedProjectId();
  return v1Json<ReadinessRun>(
    `/api/v1/projects/${encodeURIComponent(
      projectId,
    )}/readiness-runs/${encodeURIComponent(runId)}`,
    { method: "GET", signal },
  );
}

/**
 * The newest run for this server and publisher, for a page that was reloaded.
 *
 * Only ever a FALLBACK for a mount with no run id in hand: two runs started
 * close together make "the newest" the wrong answer for whoever was watching
 * the older one, so a caller that knows its run id must ask for that one.
 */
export async function findLatestHostedReadinessRun(
  publisher: DirectoryReadinessPublisher,
  serverNameOrId: string,
  signal?: AbortSignal,
): Promise<ReadinessRun | null> {
  const scope = tryResolveProjectServer(serverNameOrId);
  if (!scope) return null;
  const params = new URLSearchParams({
    readinessKind: publisher,
    serverId: scope.serverId,
    limit: "1",
  });
  const page = await v1Json<{ items?: ReadinessRun[] }>(
    `/api/v1/projects/${encodeURIComponent(
      scope.projectId,
    )}/readiness-runs?${params}`,
    { method: "GET", signal },
  );
  return page.items?.[0] ?? null;
}

/**
 * Ask the platform to stop.
 *
 * The response is a synthetic `cancelled` rather than the row: the executing
 * node learns on its next heartbeat, so the run's REAL terminal state arrives
 * on a later poll. Callers keep polling after this returns.
 */
export async function cancelHostedReadinessRun(runId: string): Promise<void> {
  const projectId = getHostedProjectId();
  await v1Json<unknown>(
    `/api/v1/projects/${encodeURIComponent(
      projectId,
    )}/readiness-runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
}

/**
 * The full graded report, fetched lazily.
 *
 * Megabytes are possible, and the run row already carries everything the
 * collapsed section renders — so this is called when a reader opens the
 * findings, not alongside every poll.
 */
export async function getHostedReadinessReport(
  runId: string,
  signal?: AbortSignal,
): Promise<DirectoryReadinessResult> {
  const projectId = getHostedProjectId();
  return v1Json<DirectoryReadinessResult>(
    `/api/v1/projects/${encodeURIComponent(
      projectId,
    )}/readiness-runs/${encodeURIComponent(runId)}/report`,
    { method: "GET", signal },
  );
}
