/**
 * Wire DTOs for the MCPJam Platform API (`/api/v1`).
 *
 * These mirror the public projections documented in the repo OpenAPI spec
 * (`docs/reference/openapi.json`) and emitted by the Convex catalog reads
 * (`mcpjam-backend/convex/publicApi/dtos.ts`). Write tolerant readers:
 * additive fields are non-breaking and must be ignored, never relied on
 * being absent.
 */
import type { ServerDoctorResult } from "../server-doctor-core.js";

/** Collection envelope: `nextCursor` is omitted on the last page. */
export type PlatformPage<TItem> = {
  items: TItem[];
  nextCursor?: string;
};

export interface PlatformMe {
  id: string;
  email: string;
  name: string;
  imageUrl: string | null;
  profilePictureUrl: string | null;
  plan: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformProject {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  organizationId: string | null;
  visibility: string | null;
  /** Caller's role on the project when the upstream query resolves one. */
  role?: string;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformProjectServer {
  id: string;
  projectId: string | null;
  name: string;
  enabled: boolean;
  transportType: string;
  /** Endpoint for HTTP-transport servers; null for stdio. */
  url: string | null;
  useOAuth: boolean;
  hasClientSecret: boolean;
  oauthScopes?: string[];
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformEvalRunSummary {
  id: string | null;
  status: string | null;
  passRate: number | null;
  passed: number | null;
  failed: number | null;
  createdAt: number | null;
}

export interface PlatformEvalSuite {
  id: string;
  name: string | null;
  projectId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  latestRun: PlatformEvalRunSummary | null;
  totals: { passed: number; failed: number; runs: number };
  passRateTrend: number[];
}

export interface PlatformChatSession {
  id: string;
  title: string | null;
  status: string | null;
  projectId: string | null;
  /** "private" | "project". */
  visibility: string | null;
  lastActivityAt: number | null;
  createdAt: number | null;
  isPinned?: boolean;
  isUnread?: boolean;
}

/**
 * Full eval run record, as returned by `GET /projects/{p}/eval-runs/{runId}`
 * and the suite run-history listing. Distinct from `PlatformEvalRunSummary`,
 * the condensed latest-run projection embedded in `PlatformEvalSuite`.
 */
export interface PlatformEvalRun {
  id: string;
  suiteId: string;
  runNumber: number | null;
  /** Poll until terminal: "completed" | "failed" | "cancelled". */
  status: string;
  /** Pass/fail verdict once terminal: "passed" | "failed" | null. */
  result: string | null;
  summary: {
    total?: number;
    passed?: number;
    failed?: number;
    passRate?: number;
  } | null;
  /** Run origin: "ui" | "api" | "sdk". */
  source: string;
  notes: string | null;
  createdAt: number;
  completedAt: number | null;
}

/** `202` response of `POST /projects/{p}/eval-runs`. */
export interface PlatformEvalRunCreated {
  runId: string;
  suiteId: string;
  status: string;
  /** Per-case upsert outcomes for inline tests; empty on plain reruns. */
  caseUpsert: {
    committed?: Array<{ id?: string; name?: string }>;
    failed?: Array<{ id?: string; name?: string; error?: string }>;
  };
  /**
   * The servers the run connects to — explicit, or derived server-side from
   * the suite's saved selection when the request omitted serverIds. Absent
   * on older API deployments.
   */
  servers?: Array<{ id: string; name?: string }>;
}

/**
 * `201` response of `POST /projects/{p}/eval-suites` — an authored, runnable
 * suite created from test-case definitions (NOT run; execute it with
 * `run_eval_suite`). Tolerant reader: unknown fields pass through.
 */
export interface PlatformEvalSuiteCreated {
  suiteId: string;
  /** Suite name as persisted; echoes the request name. */
  name: string | null;
  /** The HTTP servers the suite was configured against. */
  servers?: Array<{ id: string; name?: string }>;
  /** Per-case create outcomes, mirroring eval-run caseUpsert. */
  caseUpsert: {
    committed?: Array<{ id?: string; name?: string }>;
    failed?: Array<{ id?: string; name?: string; error?: string }>;
  };
}

/**
 * Public match-option vocabulary, mirroring the suite/case UI controls. The
 * route layer translates these to the internal match-option model.
 */
export interface PublicMatchOptions {
  /**
   * `any` = order ignored; `in-order` = expected calls must appear in order
   * (extra calls allowed between them); `exact` = exact sequence.
   */
  toolCallOrder: "any" | "in-order" | "exact";
  /** `unlimited`, or the max number of unexpected extra tool calls allowed. */
  extraToolCalls: "unlimited" | number;
  /** Argument comparison strictness. */
  arguments: "ignore" | "partial" | "exact";
}

/**
 * A deterministic pass/fail check. `type` is the check vocabulary (e.g.
 * `responseContains`, `toolCalledWith`); the remaining fields depend on it.
 */
export interface PublicCheck {
  type: string;
  [key: string]: unknown;
}

/** Per-case check override: how the case's checks combine with suite defaults. */
export interface PublicCheckOverride {
  mode: "inherit" | "replace" | "extend";
  list: PublicCheck[];
}

export interface PlatformExpectedToolCall {
  tool: string;
  arguments?: Record<string, unknown>;
}

export interface PlatformEvalSuiteSettings {
  /** Minimum pass rate as a percentage, 0–100. */
  minimumAccuracy: number | null;
  matchOptions: PublicMatchOptions | null;
  checks: PublicCheck[];
  judge: { enabled: boolean; model: string | null };
}

export interface PlatformEvalSuiteHost {
  id: string;
  name: string;
  /** Server names this host runs against, when resolved. */
  servers?: string[];
}

export interface PlatformEvalSuiteSchedule {
  enabled: boolean;
  /** Interval in minutes; preserved (not cleared) when `enabled` is false. */
  intervalMinutes: number | null;
}

/**
 * Full eval suite, returned by `GET`/`PATCH /eval-suites/{id}`. Public-model
 * shape — the route layer maps this to/from the internal Convex suite. Tolerant
 * reader: unknown fields pass through.
 */
export interface PlatformEvalSuiteDetail {
  id: string;
  name: string | null;
  description: string | null;
  projectId: string | null;
  /** Server selection by name. */
  environment: { servers: string[] };
  /** Suite-level execution config; null when none is pinned. */
  executionConfig: {
    model: string;
    systemPrompt: string;
    temperature: number;
  } | null;
  /** Host attachments (multi-host). */
  hosts: PlatformEvalSuiteHost[];
  settings: PlatformEvalSuiteSettings;
  schedule: PlatformEvalSuiteSchedule;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformEvalCaseModel {
  model: string;
  provider?: string;
}

export interface PlatformEvalCaseTurn {
  prompt: string;
  expectedToolCalls: PlatformExpectedToolCall[];
  expectedOutput?: string;
}

/**
 * A single eval test case. `kind: 'render-check'` cases carry `renderCheck`
 * instead of a prompt. Public-model shape; the route maps to the internal case.
 */
export interface PlatformEvalCase {
  id: string;
  title: string;
  kind: "prompt" | "render-check";
  /** First-turn prompt (← internal query); null for render-check cases. */
  prompt: string | null;
  /** Multi-turn sequence, when present. */
  turns?: PlatformEvalCaseTurn[];
  expectedToolCalls: PlatformExpectedToolCall[];
  expectedOutput?: string;
  /** Iterations to run per eval run (← internal runs). */
  iterations: number;
  isNegative: boolean;
  scenario?: string;
  /** Execution models (plural — preserves compare behavior). */
  models: PlatformEvalCaseModel[];
  matchOptions?: PublicMatchOptions;
  checks?: PublicCheckOverride;
  renderCheck?: {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
    renderTimeoutMs?: number;
  };
  createdAt: number | null;
  updatedAt: number | null;
}

export interface PlatformEvalSuiteDeleted {
  id: string;
  deleted: true;
}

export interface PlatformEvalCaseDeleted {
  id: string;
  deleted: true;
}

/** `200` response of `POST /eval-suites/{id}/cases/generate`. */
export interface PlatformEvalCasesGenerated {
  /** The backend LLM that authored the cases — NOT the case execution model. */
  generationModel: string;
  created: PlatformEvalCase[];
  counts: { normal?: number; negative?: number };
}

export interface PlatformEvalIteration {
  id: string;
  testCaseId: string | null;
  title: string | null;
  iterationNumber: number;
  status: string;
  result: string | null;
  model: string | null;
  provider: string | null;
  startedAt: number | null;
  /** Wall-clock duration; null until terminal. */
  durationMs: number | null;
  tokensUsed: number | null;
  /** Structured token usage (input/output/cached/reasoning) when available. */
  usage: Record<string, unknown> | null;
  actualToolCalls: Array<Record<string, unknown>>;
  expectedToolCalls: Array<Record<string, unknown>>;
  error: string | null;
}

/**
 * Share link for a chatbox. The URL embeds the access token; it is visible
 * to any caller who can read the chatbox (same audience as the hosted UI).
 */
export interface PlatformChatboxLink {
  /** App-relative share path. */
  path: string;
  /** Absolute share URL. */
  url: string;
}

/** A server attached to a chatbox (HTTP servers only). */
export interface PlatformChatboxServer {
  id: string;
  name: string;
  url: string | null;
  useOAuth: boolean;
}

/** Summary of a published chatbox, as returned by the list endpoint. */
export interface PlatformChatbox {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  /** Who can use it: "project_members" | "invited_only" | "anyone_with_link". */
  mode: string | null;
  /** Chat surface style the chatbox renders (e.g. "claude", "chatgpt"). */
  hostStyle: string | null;
  hostId: string | null;
  hostName: string | null;
  serverCount: number;
  serverNames: string[];
  link: PlatformChatboxLink | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** A chatbox's full read-only settings: summary plus host execution config. */
export interface PlatformChatboxDetail extends PlatformChatbox {
  /** Model the chatbox chats with. */
  modelId: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  requireToolApproval: boolean;
  servers: PlatformChatboxServer[];
}

/**
 * Response of `POST /projects/{p}/servers/{s}/doctor` — the hosted doctor
 * result, passed through verbatim by the API. Includes the probe outcome,
 * connection state, and full tools/resources/prompts listings with
 * per-collection checks, which is why `show_servers` needs only one call
 * per server.
 */
export type PlatformDoctorReport = ServerDoctorResult<unknown>;

/**
 * Response of `POST /projects/{p}/tunnels` — the relay grant the caller
 * hosts the tunnel WebSocket with, plus the registered server record's
 * identity. The `url` embeds the plaintext `?k=` bearer secret (also
 * persisted on the server record so evals/chatboxes can target it); treat
 * the whole grant as a credential. Re-creating rotates the secret and
 * revokes the previous grant.
 */
export interface PlatformTunnelGrant {
  serverId: string;
  name?: string;
  /** True when a server record with this name already existed. */
  existed?: boolean;
  /** Previous URL, present when the existing record's URL was replaced. */
  previousUrl?: string;
  /** Previous transport, present when the record existed (e.g. "stdio"). */
  previousTransportType?: string;
  slug: string;
  /** Public tunnel URL with the `?k=` bearer secret. */
  url: string;
  /** Bearer for the relay edge WebSocket handshake. */
  connectToken: string;
  connectTokenExpiresAt?: number;
  relayWsUrl: string;
  secretVersion?: number;
}

/** Response of `POST /projects/{p}/tunnels/{serverId}/close`. */
export interface PlatformTunnelClosed {
  serverId: string;
  status: string;
}
