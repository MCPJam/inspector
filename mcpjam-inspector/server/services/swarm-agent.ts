import type { Harness } from "@mcpjam/sdk";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import type { HostComputerResource } from "../utils/built-in-tools/registry.js";

/**
 * Inspector-side adapter for the backend swarm (journey-execution)
 * runner-control API. The journey snapshot, persona driver, run record, and
 * attempt state machine live in `mcpjam-backend/convex/journeyExecution/`.
 * This file is a thin fetch wrapper that trusts the backend's already-pinned
 * snapshot — it NEVER refetches a live host config.
 *
 * Every call is authenticated with the launching member's user bearer and is
 * LAUNCHER-gated + PROJECT-member-gated server-side. Mirrors the fetch/error
 * shape of `server/services/session-agent.ts`.
 */

/**
 * Pinned host execution spec — one entry in `snapshot.hosts[]`. Carries the
 * host's runtime config as of run-create time. Connection defaults / overrides
 * are secret-free (the backend strips secrets before returning the snapshot).
 */
export interface PinnedHostExecutionSpec {
  hostId: string;
  hostName: string;
  hostConfigId: string;
  modelId: string;
  systemPrompt: string;
  temperature?: number;
  requireToolApproval: boolean;
  serverIds: string[];
  optionalServerIds?: string[];
  builtInToolIds?: string[];
  computer?: HostComputerResource;
  harness?: Harness;
  respectToolVisibility?: boolean;
  progressiveToolDiscovery?: boolean;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  /** Secret-free per-server connection defaults (transport/url/headers keys). */
  connectionDefaults?: Record<string, unknown>;
  /** Secret-free per-server connection overrides keyed by serverId. */
  serverConnectionOverrides?: Record<string, unknown>;
}

export interface PersonaSnapshot {
  personaId: string;
  name: string;
  role: string;
  notes: string;
}

export interface JourneySnapshot {
  hosts: PinnedHostExecutionSpec[];
  personaSnapshot: PersonaSnapshot;
  goal?: string;
  sessionsPerHost: number;
  maxTurns: number;
}

export interface CreateJourneyRunResult {
  runId: string;
  projectId: string;
  journeyRefId: string;
  snapshot: JourneySnapshot;
}

export type SwarmAttemptStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "rate_limited";

export interface SwarmPersonaNextTurnResponse {
  message: string;
  endSession: boolean;
}

/**
 * Carries the backend HTTP status so the route can distinguish a transactional
 * reject (e.g. a multi-host journey against `maxHosts: 1`) — surfaced as a 4xx
 * — from a 5xx / transport failure.
 */
export class SwarmAgentError extends Error {
  readonly status: number;
  readonly bodyText: string;
  constructor(status: number, bodyText: string, message: string) {
    super(message);
    this.name = "SwarmAgentError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

// Cross-repo HTTP boundary — attach an AbortSignal timeout to every call.
// Non-LLM control-plane calls (create/attempt/heartbeat) get 30s; the
// LLM-backed persona driver gets 120s to cover slower models.
const NON_LLM_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 120_000;

async function postJson<T>(
  url: string,
  bearer: string,
  body: unknown,
  timeoutMs: number
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new SwarmAgentError(
      response.status,
      errorText,
      `swarm-agent ${url} failed (${response.status}): ${errorText}`
    );
  }
  return (await response.json()) as T;
}

/**
 * Create a journey run and return the pinned execution snapshot. Pass
 * `maxHosts: 1` for the single-host slice — the backend rejects a journey with
 * more than one host transactionally BEFORE any run row is created (surfaced
 * here as a {@link SwarmAgentError} with a 4xx status).
 */
export async function createJourneyRun(
  convexHttpUrl: string,
  bearer: string,
  args: { journeyRefId: string; launchKey: string; maxHosts: number }
): Promise<CreateJourneyRunResult> {
  const data = await postJson<{
    ok?: boolean;
    runId?: string;
    projectId?: string;
    journeyRefId?: string;
    snapshot?: JourneySnapshot;
    error?: string;
  }>(
    `${convexHttpUrl}/journey-execution/runs/create`,
    bearer,
    {
      journeyRefId: args.journeyRefId,
      launchKey: args.launchKey,
      maxHosts: args.maxHosts,
    },
    NON_LLM_TIMEOUT_MS
  );
  if (
    !data.ok ||
    typeof data.runId !== "string" ||
    typeof data.projectId !== "string" ||
    typeof data.journeyRefId !== "string" ||
    !data.snapshot
  ) {
    throw new Error(
      `Invalid response from backend createJourneyRun: ${
        data.error ?? "unknown error"
      }`
    );
  }
  return {
    runId: data.runId,
    projectId: data.projectId,
    journeyRefId: data.journeyRefId,
    snapshot: data.snapshot,
  };
}

/**
 * Report an attempt state transition. The state machine is
 * `pending → running → terminal`:
 *   - The `running` transition (the CLAIM) REQUIRES `chatSessionId`; it is
 *     immutable thereafter.
 *   - A `succeeded` terminal REQUIRES the SAME `chatSessionId`.
 * So the caller must claim (`running` + the deterministic chatSessionId)
 * BEFORE executing the session and report the terminal only AFTER the
 * transcript is persisted.
 */
export async function reportAttempt(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    runId: string;
    hostId: string;
    sessionIdx: number;
    status: SwarmAttemptStatus;
    chatSessionId?: string;
    errorCode?: string;
    errorMessage?: string;
  }
): Promise<void> {
  const data = await postJson<{ ok?: boolean; error?: string }>(
    `${convexHttpUrl}/journey-execution/runs/attempt`,
    bearer,
    {
      projectId: args.projectId,
      runId: args.runId,
      hostId: args.hostId,
      sessionIdx: args.sessionIdx,
      status: args.status,
      ...(args.chatSessionId ? { chatSessionId: args.chatSessionId } : {}),
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    },
    NON_LLM_TIMEOUT_MS
  );
  if (data.ok !== true) {
    throw new Error(
      `Invalid response from backend reportAttempt: ${
        data.error ?? "unknown error"
      }`
    );
  }
}

export async function heartbeatJourneyRun(
  convexHttpUrl: string,
  bearer: string,
  args: { projectId: string; runId: string }
): Promise<void> {
  const data = await postJson<{ ok?: boolean; error?: string }>(
    `${convexHttpUrl}/journey-execution/runs/heartbeat`,
    bearer,
    { projectId: args.projectId, runId: args.runId },
    NON_LLM_TIMEOUT_MS
  );
  if (data.ok !== true) {
    throw new Error(
      `Invalid response from backend heartbeatJourneyRun: ${
        data.error ?? "unknown error"
      }`
    );
  }
}

/**
 * Platform-billed swarm persona driver: produce the next simulated USER message
 * from the run's immutable snapshot. The swarm sibling of the chatbox
 * `/session-simulation/persona-next-turn`.
 */
export async function swarmPersonaNextTurn(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    runId: string;
    hostId: string;
    transcriptSoFar: Array<{ role: "user" | "assistant"; content: string }>;
  }
): Promise<SwarmPersonaNextTurnResponse> {
  const data = await postJson<{
    ok?: boolean;
    message?: string;
    endSession?: boolean;
    error?: string;
  }>(
    `${convexHttpUrl}/journey-execution/persona-next-turn`,
    bearer,
    {
      projectId: args.projectId,
      runId: args.runId,
      hostId: args.hostId,
      transcriptSoFar: args.transcriptSoFar,
    },
    LLM_TIMEOUT_MS
  );
  if (!data.ok || typeof data.message !== "string") {
    throw new Error(
      `Invalid response from backend swarmPersonaNextTurn: ${
        data.error ?? "unknown error"
      }`
    );
  }
  return {
    message: data.message,
    endSession: data.endSession === true,
  };
}
