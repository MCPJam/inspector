/**
 * Directory readiness, from the browser.
 *
 * Two shapes hide behind one API, and the difference is not cosmetic:
 *
 *   - LOCAL runs are synchronous, unpersisted and FREE. The desktop/npx
 *     inspector dials the target itself, grades it, and hands the whole result
 *     back in the response. Nothing is stored and nothing is billed, because
 *     there is no organization to bill and no row to own the artifact.
 *
 *   - HOSTED runs are durable, leased and optionally BILLED. The start answers
 *     `202` with a run id and the run continues on a server; the panel polls
 *     it. A readiness run walks a redirect chain, discovers authorization
 *     metadata, lists tools and — when the caller asked — waits on a model, so
 *     holding the request open would make the browser tab's lifetime the run's
 *     lifetime.
 *
 * `runByMode` picks between them, which is why callers get one function per
 * operation rather than one per mode: a surface that had to know which
 * universe it was in would eventually get it wrong in exactly one place.
 */

import type {
  ClaudeReadinessResult,
  OpenAIReadinessResult,
  OpenAISubmissionMode,
} from "@mcpjam/sdk/browser";
import { isHostedMode, runByMode } from "@/lib/apis/mode-client";
import { buildServerRequest, getHostedProjectId } from "@/lib/apis/web/context";
import { webPost } from "@/lib/apis/web/base";
import { localPost } from "@/lib/apis/local-post";
import { authFetch } from "@/lib/session-token";

/** The two words the product vocabulary uses. Never `anthropic`/`chatgpt`. */
export type ReadinessPublisher = "claude" | "openai";

/**
 * The submission shapes a HOSTED run may grade.
 *
 * The package shapes need an archive no browser surface can hand to the
 * server, and they run on the local CLI. Absent from this type so a control
 * cannot offer a choice the endpoint refuses.
 */
export type HostedSubmissionMode = "mcp-only" | "mcp-imported-skills";

export type ReadinessResult = ClaudeReadinessResult | OpenAIReadinessResult;

export interface ReadinessObservationState {
  status:
    | "not-requested"
    | "pending"
    | "completed"
    | "billing-blocked"
    | "provider-failed"
    | "invalid-output";
  reason?: string;
  detail?: string;
}

export interface ReadinessLaneCoverage {
  lane: string;
  status: "ready" | "not-ready" | "incomplete";
  evaluated: number;
  notEvaluated: number;
  notApplicable: number;
  missingInputs: string[];
}

export interface ReadinessStageResult {
  stage: "technical-preflight" | "submission-ready";
  status: "ready" | "not-ready" | "incomplete";
  lanes: string[];
}

/** The durable row, as the panel polls it. */
export interface HostedReadinessRun {
  id: string;
  readinessKind: ReadinessPublisher;
  serverUrl: string;
  submissionMode: HostedSubmissionMode | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  overallStatus: "ready" | "not-ready" | "incomplete" | null;
  lanes: ReadinessLaneCoverage[];
  stages: ReadinessStageResult[];
  terminalReason: string | null;
  errorMessage: string | null;
  policySnapshotDate: string | null;
  engineVersion: string | null;
  includeLlmObservations: boolean;
  llmObservations: ReadinessObservationState;
  hasReport: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HostedReadinessReceipt {
  runId: string;
  projectId: string;
  serverId: string;
  readinessKind: ReadinessPublisher;
  status: HostedReadinessRun["status"];
  deduped: boolean;
  includeLlmObservations: boolean;
}

export interface StartReadinessInput {
  serverNameOrId: string;
  publisher: ReadinessPublisher;
  /** Required for OpenAI. Never inferred — see the route's own note. */
  submissionMode?: OpenAISubmissionMode;
  /**
   * Add model-backed observations. HOSTED ONLY, and SPENDS MCPJam credits.
   *
   * Silently ignored on the local path rather than rejected, because the local
   * endpoint has no field for it: a local run has no lease, no payer and no
   * broker, so there is nothing for the flag to switch on. The UI is
   * responsible for not offering the control outside hosted mode.
   */
  includeLlmObservations?: boolean;
}

/**
 * A local run's whole answer, or a hosted run's receipt.
 *
 * A discriminated union rather than two functions, because the CALLER is the
 * thing that must branch: a local `result` renders immediately and a hosted
 * `receipt` starts a poll, and there is no third behaviour to accidentally
 * fall into.
 */
export type StartReadinessOutcome =
  | { mode: "local"; result: ReadinessResult }
  | { mode: "hosted"; receipt: HostedReadinessReceipt };

export async function startDirectoryReadiness(
  input: StartReadinessInput,
): Promise<StartReadinessOutcome> {
  const { publisher, submissionMode } = input;
  return runByMode<StartReadinessOutcome>({
    local: async () => {
      const body = await localPost<{ result: ReadinessResult }>(
        `/api/mcp/conformance/readiness/${publisher}`,
        {
          serverId: input.serverNameOrId,
          ...(submissionMode ? { submissionMode } : {}),
        },
      );
      return { mode: "local", result: body.result };
    },
    hosted: async () => {
      const request = buildServerRequest(input.serverNameOrId);
      const body = await webPost<
        Record<string, unknown>,
        { run: HostedReadinessReceipt }
      >(`/api/web/conformance/readiness/${publisher}`, {
        ...request,
        ...(submissionMode ? { submissionMode } : {}),
        includeLlmObservations: input.includeLlmObservations === true,
      });
      return { mode: "hosted", receipt: body.run };
    },
  });
}

/** Poll one hosted run. Hosted only — a local run has no row to read. */
export async function getHostedReadinessRun(
  runId: string,
): Promise<HostedReadinessRun> {
  // The project id directly, rather than through `buildServerRequest`: a run
  // id already names its server, and asking the context to resolve a server
  // name we do not have would throw on a lookup nobody needs.
  const projectId = getHostedProjectId();
  const response = await authFetch(
    `/api/web/conformance/readiness/runs/${encodeURIComponent(
      runId,
    )}?projectId=${encodeURIComponent(projectId)}`,
    { method: "GET" },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || `Request failed (${response.status})`,
    );
  }
  return (data as { run: HostedReadinessRun }).run;
}

/**
 * Stop an in-flight hosted run.
 *
 * The executing node learns about it on its next heartbeat and aborts, which
 * matters more than the row's status: the thing being stopped is traffic to
 * somebody else's server.
 */
export async function cancelHostedReadinessRun(runId: string): Promise<void> {
  await webPost<Record<string, never>, unknown>(
    `/api/web/conformance/readiness/runs/${encodeURIComponent(runId)}/cancel`,
    {},
  );
}

/**
 * The stored report for a finished hosted run.
 *
 * Fetched separately from the row on purpose: the row carries lane statuses
 * and coverage, which is what a listing needs, while the report carries every
 * finding and its evidence and can reach megabytes.
 */
export async function getHostedReadinessReport(
  runId: string,
): Promise<ReadinessResult> {
  const response = await authFetch(
    `/api/web/conformance/readiness/runs/${encodeURIComponent(runId)}/report`,
    { method: "GET" },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      data?.message || data?.error || `Request failed (${response.status})`,
    );
  }
  return data as ReadinessResult;
}

/**
 * Whether this build can offer model observations at all.
 *
 * Not a preference — a capability. The broker, the lease and the payer only
 * exist on the hosted path, so a local build offering the control would be
 * offering a checkbox with nothing behind it.
 */
export function canRequestModelObservations(): boolean {
  return isHostedMode();
}
