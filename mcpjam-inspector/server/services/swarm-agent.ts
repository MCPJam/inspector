import type { Harness } from "@mcpjam/sdk";
import type {
  HostConfigMcpProfileV1,
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config/internal";
import type { HostComputerResource } from "../utils/built-in-tools/registry.js";
import type { PinnedSkillArtifact } from "../../shared/skill-types.js";

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
/**
 * Reference to the environment an ENV-BASED execution target was resolved from
 * (Project Environments). `environmentId` is the first-class id the session-id
 * mint keys on — never derive it from `targetId`.
 */
export interface JourneyEnvironmentRef {
  environmentId: string;
  name: string;
  revision: number;
}

/**
 * Per-skill metadata pinned onto a snapshot target (bodies are NOT inline —
 * the runner fetches them via {@link fetchPinnedSkill}). Mirrors the backend
 * `PinnedSkillMeta`; `channels` is the P0.2 host/environment provenance and is
 * absent on pre-P0.2 snapshots.
 */
export interface PinnedSkillMeta {
  skillId?: string;
  name: string;
  description: string;
  contentHash: string;
  sharing?: "user" | "project";
  channels?: Array<"host" | "environment">;
}

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
  /**
   * Pinned host MCP profile — the INITIALIZE pins (`mcpProtocolVersion` +
   * `initialize.{clientInfo,supportedProtocolVersions}`) captured at run-create
   * time. The backend's `materializeHostSpec` copies the host's `mcpProfile`
   * VERBATIM onto the snapshot (secret-free); the swarm route reads the
   * initialize pins from HERE, not from the scrubbed `connectionDefaults` (which
   * the backend strips down to just `{ requestTimeout }`).
   */
  mcpProfile?: HostConfigMcpProfileV1;
  /**
   * Pinned MCP client capabilities advertised on INITIALIZE, captured at
   * run-create time. Passed into `createAuthorizedManager` so the run negotiates
   * with the SAME capabilities the host declared (mirrors the chatbox path's
   * `clientCapabilities`), not whatever the current live config would send.
   */
  clientCapabilities?: Record<string, unknown>;
  /**
   * Secret-free per-server connection defaults. The backend strips this to just
   * `{ requestTimeout }` (header values are dropped) — INITIALIZE pins live on
   * `mcpProfile`, NOT here.
   */
  connectionDefaults?: Record<string, unknown>;
  /** Secret-free per-server connection overrides keyed by serverId. */
  serverConnectionOverrides?: Record<string, unknown>;
  /**
   * Opaque execution-target id (Project Environments). Present on every fresh
   * run's targets (`host:` / `environment:` shaped — NEVER parsed here); absent
   * on historical pre-environments snapshots. Echoed verbatim on attempt
   * claim/terminal and chat ingestion so two targets sharing a host stay
   * unambiguous.
   */
  targetId?: string;
  /** Set for ENVIRONMENT-based targets only; absent ⇒ legacy host target. */
  environmentRef?: JourneyEnvironmentRef;
  /** The environment's standalone server-group pointer (provenance only). */
  serverAttachmentId?: string;
  /**
   * Host-carried skill selection snapshotted from the host config (#767 —
   * inline, no skill-group ref). Provenance only on this side: the runner
   * never resolves it live — pinned bodies come from `pinnedSkills` +
   * {@link fetchPinnedSkill}. Used to detect a pre-P0.2 snapshot whose host
   * channel was NOT pinned (fail closed rather than silently dropping it).
   */
  skillSelection?: { mode: "explicit"; skillIds: string[] } | null;
  /**
   * Pinned skill METADATA for this target (bodies fetched separately). After
   * P0.2 this is the deduped authoritative host+environment union with
   * per-entry `channels` provenance. Absent on legacy host targets (live-pool
   * semantics) AND on env targets whose composed selection is empty (the env
   * target then runs skill-less — never the live pool).
   */
  pinnedSkills?: PinnedSkillMeta[];
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
  /**
   * True when the backend deduped this launch onto an EXISTING run (launchKey
   * replay: same project + creator + journey). The original launch's runner
   * owns that run — the caller MUST NOT start a second runner for it, or the
   * duplicate's shutdown/cleanup (finalize-pending, abort finalizers) races
   * the owner and can kill attempts the owner is still executing.
   */
  deduped: boolean;
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
  timeoutMs: number,
  // Optional caller signal (e.g. the run's abort) composed with the per-call
  // timeout so EITHER a timeout OR a shutdown/cancel aborts the in-flight fetch.
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : AbortSignal.timeout(timeoutMs),
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

async function getJson<T>(
  url: string,
  bearer: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${bearer}` },
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : AbortSignal.timeout(timeoutMs),
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
 * The served pinned-skill body does not match the snapshot metadata it was
 * fetched for (hash mismatch or a malformed envelope). NEVER retried and NEVER
 * cached — it signals snapshot/store inconsistency, not a transient fault.
 */
export class PinnedSkillIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PinnedSkillIntegrityError";
  }
}

/**
 * Fetch ONE pinned skill's complete runtime artifact for an env-based target:
 * `GET /journey-execution/runs/skill?runId&projectId&targetId&contentHash`.
 * Same bearer/authorization as the attempt/heartbeat routes (project member +
 * run launcher). The response mirrors P0.2's complete artifact envelope
 * ({@link PinnedSkillArtifact}) — the shipped backend serves the SKILL.md-only
 * subset, which is the same shape with the optional extensions absent.
 *
 * Error contract (consumed by the pinned-skill cache's retry policy):
 *   - 404 → {@link SwarmAgentError} with `status: 404` (never retried — the
 *     target/hash pairing is not in the immutable snapshot).
 *   - 5xx / transport → {@link SwarmAgentError} / fetch error (retryable).
 *   - served hash ≠ requested hash → {@link PinnedSkillIntegrityError}
 *     (never retried, never cached).
 */
export async function fetchPinnedSkill(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    runId: string;
    targetId: string;
    contentHash: string;
    signal?: AbortSignal;
  }
): Promise<PinnedSkillArtifact> {
  const query = new URLSearchParams({
    runId: args.runId,
    projectId: args.projectId,
    targetId: args.targetId,
    contentHash: args.contentHash,
  });
  const data = await getJson<{
    ok?: boolean;
    skill?: PinnedSkillArtifact;
    error?: string;
  }>(
    `${convexHttpUrl}/journey-execution/runs/skill?${query.toString()}`,
    bearer,
    NON_LLM_TIMEOUT_MS,
    args.signal
  );
  const skill = data.skill;
  if (
    data.ok !== true ||
    !skill ||
    typeof skill.name !== "string" ||
    typeof skill.content !== "string" ||
    typeof skill.contentHash !== "string"
  ) {
    throw new PinnedSkillIntegrityError(
      `Invalid pinned-skill response from backend: ${
        data.error ?? "malformed envelope"
      }`
    );
  }
  if (skill.contentHash !== args.contentHash) {
    throw new PinnedSkillIntegrityError(
      `Pinned skill hash mismatch: requested ${args.contentHash}, served ${skill.contentHash}`
    );
  }
  return skill;
}

/**
 * Create a journey run and return the pinned execution snapshot.
 *
 * `maxHosts` is an optional upper bound the backend enforces transactionally
 * BEFORE any run row is created (a journey exceeding it is rejected — surfaced
 * here as a {@link SwarmAgentError} with a 4xx status). The single-host slice
 * (PR 3c) passed `maxHosts: 1`; the fan-out runner (PR 3d) omits it and lets
 * the backend pin the journey's full host set.
 */
export async function createJourneyRun(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    journeyRefId: string;
    launchKey: string;
    maxHosts?: number;
  }
): Promise<CreateJourneyRunResult> {
  const data = await postJson<{
    ok?: boolean;
    runId?: string;
    projectId?: string;
    journeyRefId?: string;
    snapshot?: JourneySnapshot;
    deduped?: boolean;
    error?: string;
  }>(
    `${convexHttpUrl}/journey-execution/runs/create`,
    bearer,
    {
      // `projectId` is REQUIRED by the backend route (it reads `body.projectId`
      // and 400s without it); it scopes the LAUNCHER + project-member gate.
      projectId: args.projectId,
      journeyRefId: args.journeyRefId,
      launchKey: args.launchKey,
      ...(args.maxHosts !== undefined ? { maxHosts: args.maxHosts } : {}),
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
    // Strict `=== true`: an absent field means a fresh run (never wrongly skip
    // starting the runner for a genuinely new launch).
    deduped: data.deduped === true,
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
 *
 * Returns the backend's `{ ok, applied }` outcome. `applied` is `true` when the
 * transition actually applied and `false` when it was a no-op replay — i.e.
 * ANOTHER runner already drove this exact (run, host, sessionIdx) attempt to (or
 * past) the reported state. The CLAIM step (`status: "running"`) uses this to
 * detect a duplicate-delivered launch: an `applied: false` claim means a sibling
 * runner already owns the attempt, so this runner MUST NOT execute/persist/bill
 * it (see swarm-runner). A conflicting transition (e.g. a terminal replay to a
 * different state) is rejected by the backend with a 4xx and surfaces here as a
 * thrown {@link SwarmAgentError}, never as `applied: false`.
 */
export async function reportAttempt(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    runId: string;
    hostId: string;
    /**
     * Opaque snapshot target id, echoed VERBATIM from the pinned spec. Required
     * in practice for env-based runs (the backend rejects a host-only lookup as
     * ambiguous when two targets share a host); omitted only for historical
     * snapshots whose targets carry no id.
     */
    targetId?: string;
    sessionIdx: number;
    status: SwarmAttemptStatus;
    chatSessionId?: string;
    errorCode?: string;
    errorMessage?: string;
  }
): Promise<{ ok: true; applied: boolean }> {
  const data = await postJson<{
    ok?: boolean;
    applied?: boolean;
    error?: string;
  }>(
    `${convexHttpUrl}/journey-execution/runs/attempt`,
    bearer,
    {
      projectId: args.projectId,
      runId: args.runId,
      hostId: args.hostId,
      ...(args.targetId ? { targetId: args.targetId } : {}),
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
  // The backend (`journeyRuns.recordAttempt`, PR 3c backend #693) always returns
  // an explicit `applied` boolean on a 200. Treat only an explicit `false` as a
  // no-op replay; anything else (incl. a defensively-absent field) is "applied"
  // so a missing field can never wrongly suppress a fresh claim's execution.
  return { ok: true, applied: data.applied !== false };
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
 * Best-effort finalize of a run's still-`pending` attempts to a terminal state.
 * WHOLE-RUN scoped (the backend body carries no `hostId`), used by the fan-out
 * runner for the two run-level short-circuits:
 *   - org spend-cap breach → `terminalStatus: "rate_limited"`,
 *     `errorCode: "spend_cap_exceeded"`
 *   - controlled shutdown / cancel → `errorCode: "runner_shutdown"`
 *
 * A provider rate-limit is per-HOST (it stops one host, not the run), so it does
 * NOT use this — the runner marks that host's remaining attempts via
 * {@link reportAttempt} instead. The backend stale-run cron is the hard backstop
 * for anything this best-effort call misses.
 */
export async function finalizePendingAttempts(
  convexHttpUrl: string,
  bearer: string,
  args: {
    projectId: string;
    runId: string;
    terminalStatus?: Exclude<SwarmAttemptStatus, "pending" | "running">;
    errorCode?: string;
    errorMessage?: string;
  }
): Promise<void> {
  const data = await postJson<{ ok?: boolean; error?: string }>(
    `${convexHttpUrl}/journey-execution/runs/finalize-pending`,
    bearer,
    {
      projectId: args.projectId,
      runId: args.runId,
      ...(args.terminalStatus ? { terminalStatus: args.terminalStatus } : {}),
      ...(args.errorCode ? { errorCode: args.errorCode } : {}),
      ...(args.errorMessage ? { errorMessage: args.errorMessage } : {}),
    },
    NON_LLM_TIMEOUT_MS
  );
  if (data.ok !== true) {
    throw new Error(
      `Invalid response from backend finalizePendingAttempts: ${
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
    // Run abort signal. This call can PARK for up to LLM_TIMEOUT_MS (120s) in
    // an uncancellable place; forwarding the run's signal lets a shutdown/cancel
    // abort the parked fetch immediately so the session can unwind.
    signal?: AbortSignal;
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
    LLM_TIMEOUT_MS,
    args.signal
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
