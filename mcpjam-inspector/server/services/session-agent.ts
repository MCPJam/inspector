import type { ServerToolSnapshot } from "../utils/export-helpers.js";
// Reuse eval-agent's attachment payload type — backend treats the wire
// shape identically for both eval generation and session simulation
// (single shared parser in mcpjam-backend/convex/lib/snapshotAttachmentScope.ts).
import type { ServerAttachmentInput } from "./eval-agent.js";

export type { ServerAttachmentInput };

/**
 * Inspector-side adapter for backend AI-generated chatbox session simulation.
 *
 * The persona-slate prompt, persona-as-user driver, and run record live in
 * `mcpjam-backend/convex/sessionSimulation/`. This file is a thin fetch
 * wrapper that trusts the backend's already-normalized payloads. Anything
 * authoring-related (system prompts, LLM calls, billing) belongs server-side.
 *
 * Mirrors the shape of `server/services/eval-agent.ts`.
 */

export interface PersonaSlate {
  id: string;
  name: string;
  role: string;
  notes: string;
}

export interface RunSummary {
  total: number;
  succeeded: number;
  failed: number;
  rateLimited: number;
}

export interface RunRecord {
  _id: string;
  chatboxId: string;
  projectId: string;
  createdAt: number;
  createdByUserId?: string;
  personaCount: number;
  sessionsPerPersona: number;
  maxTurns: number;
  personas: PersonaSlate[];
  status: "running" | "completed" | "partial" | "failed";
  summary: RunSummary;
  error?: string;
  lastHeartbeatAt: number;
}

export interface PersonaNextTurnResponse {
  message: string;
  endSession: boolean;
}

export interface DeltaSummary {
  succeeded?: number;
  failed?: number;
  rateLimited?: number;
}

// Cross-repo HTTP boundary: every Convex call here can hang on a stuck
// backend, so attach an AbortSignal timeout to all of them. Non-LLM
// control-plane calls (create/get/update) get 30s; LLM-backed calls
// (generatePersonas, personaNextTurn) get 120s to cover slower models.
const NON_LLM_TIMEOUT_MS = 30_000;
const LLM_TIMEOUT_MS = 120_000;

async function postJson<T>(
  url: string,
  convexAuthToken: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${convexAuthToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `session-agent ${url} failed (${response.status}): ${errorText}`,
    );
  }
  return (await response.json()) as T;
}

export async function generatePersonas(
  toolSnapshot: ServerToolSnapshot,
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  chatboxId: string,
  personaCount: number,
  serverAttachment?: ServerAttachmentInput,
): Promise<PersonaSlate[]> {
  const data = await postJson<{
    ok?: boolean;
    personas?: PersonaSlate[];
    error?: string;
  }>(
    `${convexHttpUrl}/session-simulation/generate-personas`,
    convexAuthToken,
    {
      projectId,
      chatboxId,
      toolSnapshot,
      personaCount,
      ...(serverAttachment ? { serverAttachment } : {}),
    },
    LLM_TIMEOUT_MS,
  );
  if (!data.ok || !Array.isArray(data.personas)) {
    throw new Error(
      `Invalid response from backend generatePersonas: ${data.error ?? "unknown error"}`,
    );
  }
  return data.personas;
}

export interface CreateRunOptions {
  /**
   * Per plan v4 §I, stamps the run as `'any'` (hosted-shareable) or
   * `'local:<workerInstanceId>'` (local Inspector only). Backend
   * defaults to `'any'` when omitted.
   */
  workerScope?: string;
  /**
   * Pre-resolved worker-safe runtime material (plan v4 §C). When
   * provided, the backend persists it on the run record so the
   * durable pump can rebuild the manager without a user bearer.
   */
  runtimeDescriptor?: Record<string, unknown>;
  /** Per-run MCPJam-billed spend cap in USD (plan v4 §E). */
  budgetUsdCap?: number;
}

export async function createRun(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  chatboxId: string,
  personas: PersonaSlate[],
  sessionsPerPersona: number,
  maxTurns: number,
  options?: CreateRunOptions,
): Promise<{ runId: string }> {
  const data = await postJson<{
    ok?: boolean;
    runId?: string;
    error?: string;
  }>(
    `${convexHttpUrl}/session-simulation/runs/create`,
    convexAuthToken,
    {
      projectId,
      chatboxId,
      personas,
      sessionsPerPersona,
      maxTurns,
      ...(options?.workerScope ? { workerScope: options.workerScope } : {}),
      ...(options?.runtimeDescriptor
        ? { runtimeDescriptor: options.runtimeDescriptor }
        : {}),
      ...(typeof options?.budgetUsdCap === "number"
        ? { budgetUsdCap: options.budgetUsdCap }
        : {}),
    },
    NON_LLM_TIMEOUT_MS,
  );
  if (!data.ok || typeof data.runId !== "string") {
    throw new Error(
      `Invalid response from backend createRun: ${data.error ?? "unknown error"}`,
    );
  }
  return { runId: data.runId };
}

export async function personaNextTurn(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  runId: string,
  personaId: string,
  transcriptSoFar: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<PersonaNextTurnResponse> {
  const data = await postJson<{
    ok?: boolean;
    message?: string;
    endSession?: boolean;
    error?: string;
  }>(
    `${convexHttpUrl}/session-simulation/persona-next-turn`,
    convexAuthToken,
    { projectId, runId, personaId, transcriptSoFar },
    LLM_TIMEOUT_MS,
  );
  if (!data.ok || typeof data.message !== "string") {
    throw new Error(
      `Invalid response from backend personaNextTurn: ${data.error ?? "unknown error"}`,
    );
  }
  return {
    message: data.message,
    endSession: data.endSession === true,
  };
}

export async function updateRun(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  runId: string,
  deltaSummary: DeltaSummary,
  status?: RunRecord["status"],
): Promise<void> {
  const data = await postJson<{ ok?: boolean; error?: string }>(
    `${convexHttpUrl}/session-simulation/runs/update`,
    convexAuthToken,
    {
      projectId,
      runId,
      deltaSummary,
      ...(status ? { status } : {}),
    },
    NON_LLM_TIMEOUT_MS,
  );
  // Backend may return HTTP 200 with {ok: false} for soft validation
  // failures; treat that as an error so callers can decide whether to
  // retry or abort the batch.
  if (data.ok !== true) {
    throw new Error(
      `Invalid response from backend updateRun: ${data.error ?? "unknown error"}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Service-token-authed helpers (plan v4 §C/§D/§F).
//
// All routes below are siblings of the user-bearer routes above. They are
// gated server-side on `INSPECTOR_SERVICE_TOKEN` (header
// `X-Inspector-Service-Token`) — mirrors the pattern at
// `server/utils/org-model-config.ts`. The token is read from the
// process env at call time so secret rotation doesn't require a
// restart of long-lived workers.
//
// Errors are surfaced as typed throwables so the durable runner can
// classify 409 lease-mismatch, 501 refresh-unavailable, and other
// failure modes without re-parsing the message.
// ---------------------------------------------------------------------------

const INSPECTOR_SERVICE_TOKEN_HEADER = "X-Inspector-Service-Token";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class SessionWorkerLeaseLostError extends Error {
  constructor(message: string = "Lease lost") {
    super(message);
    this.name = "SessionWorkerLeaseLostError";
  }
}

export class SessionWorkerRefreshUnavailableError extends Error {
  constructor(message: string = "Descriptor refresh not implemented") {
    super(message);
    this.name = "SessionWorkerRefreshUnavailableError";
  }
}

export class SessionWorkerHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "SessionWorkerHttpError";
  }
}

function requireInspectorServiceToken(): string {
  const token = process.env.INSPECTOR_SERVICE_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      "INSPECTOR_SERVICE_TOKEN env var is not set; the durable synthesis runner cannot authenticate to the backend",
    );
  }
  return token;
}

async function postJsonWithServiceToken<T>(
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<T> {
  const token = requireInspectorServiceToken();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [INSPECTOR_SERVICE_TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed: { ok?: boolean; code?: string; error?: string } & Record<
    string,
    unknown
  > = {};
  const rawText = await response.text();
  if (rawText) {
    try {
      parsed = JSON.parse(rawText) as typeof parsed;
    } catch {
      // fall through — parsed stays as a sentinel empty object
    }
  }
  if (response.status === 409) {
    throw new SessionWorkerLeaseLostError(
      typeof parsed.error === "string" ? parsed.error : "Lease lost",
    );
  }
  if (response.status === 501) {
    throw new SessionWorkerRefreshUnavailableError(
      typeof parsed.error === "string"
        ? parsed.error
        : "Descriptor refresh not implemented",
    );
  }
  if (!response.ok || parsed.ok === false) {
    throw new SessionWorkerHttpError(
      typeof parsed.error === "string"
        ? parsed.error
        : `${url} failed (${response.status})`,
      response.status,
      typeof parsed.code === "string" ? parsed.code : undefined,
    );
  }
  return parsed as T;
}

export interface ClaimedJob {
  kind: "claimed";
  jobId: string;
  runId: string;
  projectId: string;
  chatboxId: string;
  personaId: string;
  sessionIndex: number;
  attemptCount: number;
  /**
   * Lease owner the backend stamped onto the claim. Echoed back to
   * heartbeat/complete/fail so a stale process can't mutate someone
   * else's job. The durable runner passes this through verbatim.
   */
  leaseOwner: string;
  leaseExpiresAt: number;
  /**
   * Worker-safe runtime material persisted on the run record at
   * `runs/create` time (plan v4 §C). The pump rebuilds the MCP
   * manager from this without a user bearer.
   *
   * `null` means the run predates the descriptor field (legacy v2
   * row) — the worker terminal-fails the job with
   * `errorCode='missing_descriptor'`.
   */
  runtimeDescriptor: Record<string, unknown> | null;
  /** Full persona record (id, name, role, notes). */
  persona: PersonaSlate;
  /** Mirrored from the run record so the worker doesn't need to refetch. */
  maxTurns: number;
}

export interface BudgetCapTerminatedJob {
  kind: "budget_cap_terminated";
  jobId: string;
  runId: string;
}

export interface NoJobAvailable {
  kind: "no_job";
}

export type ClaimJobResult =
  | ClaimedJob
  | BudgetCapTerminatedJob
  | NoJobAvailable;

export async function claimJob(
  convexHttpUrl: string,
  body: {
    workerInstanceId: string;
    workerScope: string;
    estimatedTurnCostUsd?: number;
  },
): Promise<ClaimJobResult> {
  const data = await postJsonWithServiceToken<
    {
      ok: true;
      kind: ClaimJobResult["kind"];
    } & Record<string, unknown>
  >(
    `${convexHttpUrl}/session-simulation/jobs/claim`,
    body,
    NON_LLM_TIMEOUT_MS,
  );
  if (data.kind === "no_job") return { kind: "no_job" };
  if (data.kind === "claimed") {
    // Persona is fanned out by the backend so the worker can drive the
    // session without a second Convex round-trip. Trust the wire shape
    // defensively — missing fields surface as `execution_error` upstream.
    const personaRaw = isRecord(data.persona) ? data.persona : null;
    const persona: PersonaSlate = {
      id: String(personaRaw?.id ?? data.personaId),
      name: typeof personaRaw?.name === "string" ? personaRaw.name : "",
      role: typeof personaRaw?.role === "string" ? personaRaw.role : "",
      notes: typeof personaRaw?.notes === "string" ? personaRaw.notes : "",
    };
    const runtimeDescriptor = isRecord(data.runtimeDescriptor)
      ? (data.runtimeDescriptor as Record<string, unknown>)
      : null;
    return {
      kind: "claimed",
      jobId: String(data.jobId),
      runId: String(data.runId),
      projectId: String(data.projectId),
      chatboxId: String(data.chatboxId),
      personaId: String(data.personaId),
      sessionIndex: Number(data.sessionIndex),
      attemptCount: Number(data.attemptCount),
      leaseOwner: String(data.leaseOwner),
      leaseExpiresAt: Number(data.leaseExpiresAt),
      runtimeDescriptor,
      persona,
      maxTurns: Number(data.maxTurns),
    };
  }
  return {
    kind: "budget_cap_terminated",
    jobId: String(data.jobId),
    runId: String(data.runId),
  };
}

export async function heartbeatJob(
  convexHttpUrl: string,
  body: { jobId: string; leaseOwner: string; leaseTtlMs?: number },
): Promise<{ leaseExpiresAt: number }> {
  const data = await postJsonWithServiceToken<{
    ok: true;
    leaseExpiresAt: number;
  }>(
    `${convexHttpUrl}/session-simulation/jobs/heartbeat`,
    body,
    NON_LLM_TIMEOUT_MS,
  );
  return { leaseExpiresAt: Number(data.leaseExpiresAt) };
}

export async function completeJob(
  convexHttpUrl: string,
  body: {
    jobId: string;
    leaseOwner: string;
    resultChatSessionId: string;
  },
): Promise<void> {
  await postJsonWithServiceToken<{ ok: true }>(
    `${convexHttpUrl}/session-simulation/jobs/complete`,
    body,
    NON_LLM_TIMEOUT_MS,
  );
}

export async function failJob(
  convexHttpUrl: string,
  body: {
    jobId: string;
    leaseOwner: string;
    errorCode: string;
    errorMessage?: string;
  },
): Promise<void> {
  await postJsonWithServiceToken<{ ok: true }>(
    `${convexHttpUrl}/session-simulation/jobs/fail`,
    body,
    NON_LLM_TIMEOUT_MS,
  );
}

/**
 * Service-token sibling of `personaNextTurn`. Threads `runId` + `jobId`
 * so the backend can attribute the persona-driver model spend to the
 * synthesis run (plan v4 §E).
 */
export async function personaNextTurnWorker(
  convexHttpUrl: string,
  body: {
    projectId: string;
    runId: string;
    jobId: string;
    personaId: string;
    transcriptSoFar: Array<{ role: "user" | "assistant"; content: string }>;
  },
): Promise<PersonaNextTurnResponse> {
  const data = await postJsonWithServiceToken<{
    ok: true;
    message?: string;
    endSession?: boolean;
  }>(
    `${convexHttpUrl}/session-simulation/persona-next-turn/worker`,
    body,
    LLM_TIMEOUT_MS,
  );
  if (typeof data.message !== "string") {
    throw new SessionWorkerHttpError(
      "Invalid persona-next-turn/worker response: missing message",
      502,
    );
  }
  return { message: data.message, endSession: data.endSession === true };
}

/**
 * Rotate the run's stored OAuth tokens via the backend. Returns true
 * when the backend successfully refreshed; throws
 * `SessionWorkerRefreshUnavailableError` on 501 (Stage 3 TODO) so the
 * caller can terminal-fail the job with `errorCode='refresh_unavailable'`.
 */
export async function refreshDescriptorTokens(
  convexHttpUrl: string,
  runId: string,
): Promise<{ ok: true }> {
  return await postJsonWithServiceToken<{ ok: true }>(
    `${convexHttpUrl}/session-simulation/runtime-descriptor/refresh-tokens`,
    { runId },
    NON_LLM_TIMEOUT_MS,
  );
}

export async function getRun(
  convexHttpUrl: string,
  convexAuthToken: string,
  projectId: string,
  runId: string,
): Promise<{ run: RunRecord; threadIds: string[] }> {
  const url = new URL(
    `${convexHttpUrl}/session-simulation/runs`,
  );
  url.searchParams.set("runId", runId);
  url.searchParams.set("projectId", projectId);
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${convexAuthToken}`,
    },
    signal: AbortSignal.timeout(NON_LLM_TIMEOUT_MS),
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `session-agent getRun failed (${response.status}): ${errorText}`,
    );
  }
  const data = (await response.json()) as {
    ok?: boolean;
    run?: RunRecord;
    threadIds?: string[];
    error?: string;
  };
  if (!data.ok || !data.run) {
    throw new Error(
      `Invalid response from backend getRun: ${data.error ?? "unknown error"}`,
    );
  }
  return { run: data.run, threadIds: data.threadIds ?? [] };
}
