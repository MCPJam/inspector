/**
 * Wire DTOs for the MCPJam Platform API (`/api/v1`).
 *
 * These mirror the public projections documented in the repo OpenAPI spec
 * (`docs/reference/openapi.json`) and emitted by the Convex catalog reads
 * (`mcpjam-backend/convex/publicApi/dtos.ts`). Write tolerant readers:
 * additive fields are non-breaking and must be ignored, never relied on
 * being absent.
 */
import type { PlatformPermalink } from "./permalinks.js";
import type { ServerDoctorResult } from "../server-doctor-core.js";
import type {
  EvaluationConfigSnapshot,
  ScoreResult,
} from "../contract/types.js";
import type {
  EvalRunDecisionSummary,
  EvalStageAnalyticsV1,
  EvalSuiteFileCaseImport,
  EvalVerdictDecision,
  FailureCategory,
  StageResultRow,
  UserValueStage,
} from "../contract/index.js";

/**
 * Response of
 * `GET /projects/{p}/eval-runs/{runId}/decision-summary` — the canonical,
 * versioned run decision contract.
 *
 * An ALIAS, not a second declaration. The shape is owned by
 * `@mcpjam/sdk/contract` (`evalRunDecisionSummarySchema`), which is what makes
 * the API's response and a client-side assembly the same object rather than two
 * hand-mirrored descriptions of one; re-declaring it here as an interface would
 * recreate exactly the drift this lane removed.
 */
export type PlatformEvalRunDecisionSummary = EvalRunDecisionSummary;

/**
 * One item of
 * `GET /projects/{p}/eval-suites/{suiteId}/stage-analytics` — one RUN's
 * complete materialized stage-analytics document.
 *
 * An ALIAS, for the same reason the decision summary is one: the shape is owned
 * by `@mcpjam/sdk/contract` (`evalStageAnalyticsSchema`), and re-declaring it
 * here would produce two hand-mirrored descriptions of one contract that drift
 * the first time a field is added.
 *
 * Rates are NOT on this object. It carries counts, and every rate is derived by
 * the contract's own helpers (`measuredPassRate`, `measurementCoverageRate`,
 * `reachRate`, `latencyMeanMs`) so a zero denominator stays `notMeasured`
 * instead of becoming a `0%` nobody can act on.
 */
export type PlatformEvalStageAnalytics = EvalStageAnalyticsV1;

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

/**
 * An organization the caller belongs to — the ids `list_projects` and
 * `create_project` take as `organizationId`.
 *
 * Deliberately thin. The backing query is the browser app shell's, so it
 * carries billing and Stripe fields this transport DTO drops: an organization
 * on the machine surfaces is a SCOPE (an id, a name, and enough context to
 * pick between two of them), not an account-management object.
 */
export interface PlatformOrganization {
  id: string;
  name: string;
  /** Billing plan slug (`free` / `team` / `enterprise`) when resolved. */
  plan: string | null;
  /** Caller's role in the organization (`owner` / `admin` / `member`). */
  myRole: string | null;
  /** Whether the caller created the organization. */
  isCreator: boolean;
  logoUrl: string | null;
  createdAt: number | null;
}

/** A hosted model catalog entry. Unknown additive fields are tolerated. */
export interface PlatformModel {
  id: string;
  name?: string;
  provider?: string;
  [field: string]: unknown;
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

export interface PlatformCatalogOauthProbe {
  probedAt?: number;
  endpointUrl?: string;
  outcome?: string;
  supportsDcr?: boolean;
  supportsCimd?: boolean;
  authorizationServerUrl?: string;
}

/**
 * Scraped directory row — allowlisted; unknown upstream fields are dropped.
 *
 * The nullable fields match the wire: the backend DTO
 * (`mcpjam-backend/convex/publicApi/dtos.ts::toCatalogServerDto`) emits
 * `null` for an absent value on these, never omits them.
 */
export interface PlatformCatalogServer {
  id: string;
  source: string;
  serverName: string;
  displayName?: string;
  description?: string | null;
  rowType?: string;
  verifiedTier?: string | null;
  authPosture?: string | null;
  unavailableReason?: string | null;
  endpointKind?: string;
  remoteUrl?: string;
  remoteUrlOptions?: string[];
  remoteUrlRegex?: string;
  remoteUrlHint?: string;
  latestContentHash?: string | null;
  oauthProbe?: PlatformCatalogOauthProbe;
}

/**
 * The directory search page, plus the server's echo of which mode actually
 * ran: `"search"` when a non-blank `q` selected text search, `"browse"` for
 * the plain listing. Optional so a tolerant reader survives a backend that
 * predates the marker.
 */
export type PlatformDirectorySearchPage =
  PlatformPage<PlatformCatalogServer> & {
    mode?: "search" | "browse";
  };

export interface PlatformCatalogSourceStatus {
  source: string;
  lastSyncedAt?: number | null;
  liveCount?: number | null;
  upstreamFetchedAt?: number | null;
}

export interface PlatformRegistryServerTransport {
  transportType?: string;
  url?: string | null;
  useOAuth?: boolean;
  hasOAuthConfig?: boolean;
  oauthScopes?: string[];
}

export interface PlatformRegistryServer {
  id: string;
  scope: "global" | "organization";
  name: string;
  displayName?: string;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  publisher?: string | null;
  status?: string;
  updatedAt?: number | null;
  transport?: PlatformRegistryServerTransport;
}

export interface PlatformRegistryConnection {
  id: string;
  kind: "registry" | "catalog";
  scope?: "global" | "organization";
  projectId: string | null;
  serverId: string;
  serverName?: string | null;
  registryServerId?: string;
  catalogServerId?: string;
  endpointUrl?: string;
  endpointKind?: string;
  connectedAt?: number | null;
}

export interface PlatformRegistryInstall {
  serverId: string;
  serverName: string;
  outcome: "created" | "reconnected";
}

export interface PlatformRegistryInstallNextSteps {
  connectionStatusOp: "get_project_server_connection_status";
  connectLinkUrl?: string;
  /**
   * Present when an OAuth install could not mint its browser connect-link.
   * The install itself succeeded; the caller starts connect_project_server
   * themselves instead of waiting for a link that is not coming.
   */
  connectLinkError?: string;
}

export interface PlatformRegistryInstallResult extends PlatformRegistryInstall {
  nextSteps: PlatformRegistryInstallNextSteps;
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
 * Tool-effects policy for an agent Playground turn.
 *
 * `read_only` advertises only tools the server annotated
 * `annotations.readOnlyHint === true`; `auto` advertises everything the target
 * exposes and may therefore cause real external side effects through arbitrary
 * third-party tools. The hint is SERVER-ASSERTED, so `read_only` is a policy
 * the host applies, not a guarantee it can verify.
 */
export type PlatformToolMode = "read_only" | "auto";

/**
 * One tool call as the agent Playground reports it.
 *
 * `input`/`output` are the RAW wire values — scrubbed of protocol annotations
 * (`_meta`, `$`-prefixed keys) and bounded, with `truncated` set whenever the
 * caller is seeing less than the whole payload. That bounding is announced
 * rather than silent because a shortened tool result an agent believes is
 * complete sends it debugging the wrong thing.
 */
export interface PlatformTurnToolCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
  status: "ok" | "error";
  output?: unknown;
  errorMessage?: string;
  truncated?: true;
}

/** One turn's execution trace, in the same span shape eval iterations use. */
export interface PlatformTurnTrace {
  turnId: string;
  spanCount: number;
  spans: unknown[];
}

/** Token usage for one turn. */
export interface PlatformTurnUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * The result of one agent Playground turn.
 *
 * `sessionId` is the ONE public id — pass it back to continue the
 * conversation, and to `getChatSession` / `getChatSessionTrace` to read what
 * happened. It is `null` only when the turn ran but its transcript did not
 * persist, which `persisted.outcome` reports: a caller must not treat that as
 * "nothing happened", because the turn already spent.
 */
export interface PlatformChatTurn {
  sessionId: string | null;
  turnId: string;
  /**
   * The project this turn ran in.
   *
   * A CONTINUATION does not send one — it is read off the session row — so
   * without this a caller holding only the turn cannot say where the session
   * lives, and the session permalink cannot be composed. That is not
   * hypothetical: it is the one operation whose scope is never resolved
   * locally, so nothing else in the response or the context carries it.
   */
  projectId: string;
  reply?: string;
  finishReason?: string | null;
  toolCalls?: PlatformTurnToolCall[];
  trace?: PlatformTurnTrace;
  usage?: PlatformTurnUsage;
  model?: { id: string; provider: string };
  toolMode?: PlatformToolMode;
  advertisedToolCount?: number;
  excludedToolCount?: number;
  persisted: { outcome: string; version?: number };
  origin: string;
  /** Set when an idempotencyKey replayed an already-completed turn. */
  replay?: true;
  message?: string;
}

/** One message from a session transcript, at its ABSOLUTE transcript index. */
export interface PlatformChatMessage {
  /**
   * Position in the STORED transcript, not in the returned page. Trace spans
   * reference messages positionally, so renumbering per page would break the
   * one join the detail read exists to enable.
   */
  index: number;
  role: string;
  content: unknown;
  truncated?: true;
}

/** Session metadata plus a bounded window of raw messages. */
export interface PlatformChatSessionDetail {
  sessionId: string;
  projectId: string | null;
  origin: string | null;
  modelId: string | null;
  version: number | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  toolMode: PlatformToolMode | null;
  environmentId: string | null;
  /** `null` — never 0 — when the transcript could not be read. */
  messageCount: number | null;
  transcriptUnavailable?: true;
  messages: PlatformChatMessage[];
  nextMessageIndex?: number;
}

/** One turn's entry in a trace read. */
export interface PlatformChatSessionTraceTurn {
  turnId: string;
  promptIndex: number;
  startedAt: number;
  endedAt: number;
  finishReason?: string;
  modelId?: string;
  usage?: PlatformTurnUsage;
  spanCount: number;
  spans?: unknown[];
  /**
   * The spans could not be read. DISTINCT from an empty `spans` array, which
   * means the turn genuinely made no recorded calls — the two lead to opposite
   * conclusions about a turn.
   */
  spansUnavailable?: true;
  /** Fewer spans came back than the turn recorded. */
  spansTruncated?: true;
}

export interface PlatformChatSessionTrace {
  sessionId: string;
  origin: string | null;
  traceVersion: number;
  turnCount: number;
  turns: PlatformChatSessionTraceTurn[];
  latestPromptIndex?: number;
}

/** One interactive element in a widget snapshot, ready to use as a step target. */
export interface PlatformSnapshotElement {
  role?: { role: string; name?: string };
  testId?: string;
  text?: string;
  /** More than one element matched — pass `nth` on a step target to pick one. */
  ambiguous?: true;
}

/**
 * A rendered MCP App widget as TEXT.
 *
 * The point is that it is ACTIONABLE, not merely descriptive: the elements come
 * back in the same role/name/testId vocabulary the interaction steps accept, so
 * a caller reads a control here and addresses it directly.
 */
export interface PlatformWidgetSnapshot {
  mode: "a11y";
  tree: string;
  elements: PlatformSnapshotElement[];
  truncated?: true;
  capturedAt: number;
  note?: string;
}

/** The verdict and evidence from one headless widget render. */
export interface PlatformWidgetRender {
  status: string;
  resourceUri?: string;
  bridgeInitialized?: boolean;
  /**
   * What the widget logged, and what it was blocked from reaching. Both matter
   * more than they look: a widget that "renders" while every fetch is blocked
   * photographs perfectly and is broken.
   */
  consoleErrors?: string[];
  blockedRequests?: string[];
  snapshot?: PlatformWidgetSnapshot;
  /** Present only when `includeScreenshot` was explicitly requested. */
  screenshot?: { mimeType: string; base64: string };
  timings?: { renderMs?: number; totalMs?: number };
}

/**
 * Which session surface a row came from. Open-ended on the wire: switch on it
 * and tolerate an unknown value rather than assuming this list is closed.
 */
export type PlatformSessionSourceType =
  | "direct"
  | "scenario"
  | "eval"
  | "swarm";

/** The session's parent run, discriminated on `kind`. Also open-ended. */
export interface PlatformSessionParentRef {
  kind: "evalRun" | "journeyRun" | "scenario";
  /** Human-readable parent name; null when the parent row is gone. */
  label: string | null;
  iterationId?: string;
  /** eval only; null means Quick Run (no suite run exists). */
  suiteRunId?: string | null;
  suiteId?: string | null;
  journeyRunId?: string;
  journeyRefId?: string | null;
  scenarioId?: string;
}

/**
 * Where a human goes to read a session. Always present.
 *
 * A PROJECTION of `PlatformPermalink`, not a widening of it: the wire
 * contract for `/v1/sessions` rows is exactly `{path, url}` today, and adding
 * `label`/`resource` as REQUIRED fields would make every older backend's
 * response fail a client that trusted the type. Deriving it from
 * `PlatformPermalink` instead of restating the two fields is what stops the
 * shared permalink shape and the session wire shape from drifting apart —
 * rename `path` there and this stops compiling here.
 *
 * The backend may later add `label`/`resource` as OPTIONAL fields without
 * breaking a client built against this.
 */
export type PlatformSessionLink = Pick<PlatformPermalink, "path" | "url">;

/**
 * One row of the unified, cross-surface sessions feed
 * (`GET /projects/{projectId}/sessions`).
 *
 * Distinct from `PlatformChatSession`, which is the Playground-only projection
 * behind the older `/chat-sessions` route: this one spans every surface,
 * carries a typed parent reference, and pages on an opaque cursor.
 */
export interface PlatformSessionSummary {
  id: string;
  chatSessionId: string;
  projectId: string | null;
  sourceType: PlatformSessionSourceType;
  origin: string | null;
  status: string;
  synthetic: boolean;
  lockReason: string | null;
  title: string | null;
  firstMessagePreview: string;
  /** Direct sessions only: "private" | "project". null elsewhere. */
  visibility: string | null;
  ownedByViewer: boolean;
  startedAt: number;
  lastActivityAt: number;
  modelId: string | null;
  messageCount: number;
  /** Absent (not 0) when the session never reported the counter. */
  cumulativeUserMessageCount?: number;
  cumulativeToolCallCount?: number;
  cumulativeInputTokens?: number;
  cumulativeOutputTokens?: number;
  parentRef: PlatformSessionParentRef | null;
  link: PlatformSessionLink;
  /**
   * Transcript-scope results only: a window of the transcript around the
   * match. `null` when no window could be located; ABSENT on title-scope
   * results, which have no transcript to quote.
   */
  matchPreview?: string | null;
}

/**
 * The sessions page, plus the server's echo of the search scope it actually
 * honored.
 *
 * The echo exists so a client can tell an UNDERSTOOD `scope` from an IGNORED
 * one. A backend predating the parameter drops it silently and returns title
 * results; without the marker those are indistinguishable from the transcript
 * results the caller asked for. `scope` is optional here precisely because
 * such a backend omits it — its absence is the signal, and callers requesting
 * a non-default scope must check for it.
 */
export type PlatformSessionsPage = PlatformPage<PlatformSessionSummary> & {
  scope?: string;
};

/**
 * An audited, time-boxed override of a run's gate.
 *
 * A waiver never changes the run's own `result` — the run keeps its honest
 * verdict, and every reader that honors the waiver says so out loud instead.
 * That is what makes "no silent waiver" checkable rather than promised: the
 * evidence and the override are two separate records, and nothing collapses
 * them.
 */
export interface PlatformGateWaiver {
  id: string;
  suiteId: string;
  /** The run this waiver covers. Suite-wide waivers are not honored. */
  runId: string | null;
  /**
   * Why the gate was overridden, as the granter wrote it.
   *
   * UNREDACTED free text, retained for the life of the suite and readable by
   * anyone who can see it. Any surface that ACCEPTS one must say so before
   * taking it — see `GATE_WAIVER_REASON_NOTICE` in the gate engine.
   */
  reason: string;
  /** Epoch ms. Always in the future at creation, and capped at 30 days out. */
  expiresAt: number;
  createdAt: number;
  createdBy: string;
  /** `null`, never absent, when it cannot be resolved (e.g. a deleted user). */
  createdByEmail: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
  /**
   * Whether it is in force right now — neither revoked nor expired.
   *
   * A client that must not honor a lapsed waiver should re-derive this from
   * `expiresAt` rather than trust it: the platform computes it at read time,
   * and a cached read can outlive the instant it changes.
   */
  active: boolean;
  /**
   * WHAT was overridden, captured at waive time so a later edit to the suite's
   * criteria cannot rewrite the record.
   *
   * `null` for a run decided by the v2 verdict policy: that policy's identity
   * is recorded on the audit event instead, because this shape cannot hold it
   * and filling it in would be a false record rather than an incomplete one.
   */
  policySnapshot: { minimumPassRate: number } | null;
}

/**
 * The result of granting or revoking a waiver.
 *
 * `status` distinguishes the write from the two IDEMPOTENT no-ops, and both
 * no-ops are successes rather than errors:
 *
 *   - `conflict` — a waiver was already in force, and `waiver` is that
 *     EXISTING one rather than a second row.
 *   - `already_revoked` — this waiver had already been revoked, and `waiver`
 *     reports the original revocation rather than restamping it, so the record
 *     of who actually ended it survives a second call.
 *
 * `republishedChecks` counts the GitHub Check Runs brought back in line by
 * this write. A published check is a persisted verdict, not a live read, so
 * `0` here on a repository with checks connected means the visible CI status
 * did not change — worth surfacing, since the check is the thing that gates
 * the merge.
 */
export interface PlatformGateWaiverWriteResult {
  status: "created" | "conflict" | "revoked" | "already_revoked";
  republishedChecks: number;
  waiver: PlatformGateWaiver;
}

/** The active waiver over a run, or `null` when there is none. */
export interface PlatformGateWaiverRead {
  waiver: PlatformGateWaiver | null;
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
  /**
   * Verdict once terminal: `"passed" | "failed" | "inconclusive" | null`.
   *
   * `"inconclusive"` exists only under `verdictPolicyVersion: 2` and is NOT a
   * failure: the run did not measure the server well enough to say (too few
   * gradeable trials, too many evaluator errors), so a gate that folds it into
   * `failed` reports a server defect the run never observed. Read
   * `verdictSummary.reasons` for which check withheld the verdict.
   */
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
  /**
   * The project environment this run executed against, read from the run's
   * immutable config snapshot — NOT the suite's current attachments, which may
   * have changed since. `null` for a legacy (saved-server-selection) run, and
   * absent on API deployments that predate run environment attribution.
   */
  environment?: PlatformEvalRunEnvironment | null;
  /** Shared by every per-target run from the same fan-out launch. */
  runGroupId?: string;
  /** Model the run actually executed with. Absent on pre-attribution rows. */
  effectiveModelId?: string;
  /** `"client_default"` inherited the host model; `"override"` used env.modelId. */
  modelSource?: "client_default" | "override";
  /**
   * Which engine executed the run: `"emulated"` (the platform's own turn loop)
   * or `"harness:<id>"` (a real agent runtime such as Claude Code).
   *
   * ABSENT means the run recorded no engine — a run created before the
   * platform attributed one. Treat that as UNKNOWN, never as `"emulated"`:
   * those are different claims, and the runs whose engine was never recorded
   * are exactly the ones a reader must not vouch for.
   */
  executionEngine?: "emulated" | `harness:${string}`;
  /**
   * Whether the run's score evidence verified at ingest.
   *
   * TRI-STATE, and the third state matters: `"valid"` means the backend
   * checked and the definitions and results agree; `"invalid"` means they did
   * not; `null`/absent means NO VERDICT WAS PRODUCED — an API deployment that
   * predates integrity checking. A score gate must treat `null` exactly like
   * `"invalid"`: absent evidence is not valid evidence.
   */
  scoreIntegrity?: "valid" | "invalid" | null;
  /**
   * The verdict policy this run was decided under, frozen at run start.
   *
   * ABSENT means legacy percent-threshold grading — the run's `result` cannot
   * be `"inconclusive"` and there is no `verdictSummary` to read. A caller
   * that gates on fractions or on validity must check this first rather than
   * assume a missing summary means a clean run.
   */
  verdictPolicyVersion?: 2;
  /**
   * How the verdict was reached: the resolved validity policy, the measured
   * rates with their denominators and exclusions, the per-case and
   * per-execution-variant aggregates, and the exact reasons.
   *
   * Absent when the run was not decided under policy 2, or when the stored
   * summary failed contract validation at the boundary — a public caller never
   * receives a partially-valid decision, since a gate cannot tell the
   * difference between a missing field and a satisfied check.
   */
  verdictSummary?: EvalVerdictDecision;
  /**
   * Why a policy-2 run could not be decided from its own evidence (a missing
   * or malformed policy snapshot, mixed evaluator configs). Accompanies an
   * `"inconclusive"` result; it is never a task failure.
   */
  verdictPolicyIntegrityError?: string;
  /**
   * The waiver currently in force over this run's gate, or `null`.
   *
   * Gated on being able to VIEW the run, deliberately not on being able to
   * grant a waiver: a waiver only its grantors could see would not be a
   * visible one, and visibility is the half of the charter this field exists
   * to serve.
   *
   * `null` means no waiver. ABSENT means an API deployment that predates the
   * field, which is a different fact and must not be read as "not waived" by
   * anything that needs to be sure.
   *
   * Carried on the run projection rather than fetched separately so `eval
   * gate` — which already GETs this run — can fold a waiver into its report
   * without a second round trip on the gating path.
   */
  gateWaiver?: PlatformGateWaiver | null;
  createdAt: number;
  completedAt: number | null;
  /**
   * The common actionable-insights envelope. Present on the DETAIL response
   * only (lists stay compact) and absent on servers deployed before the
   * envelope existed — treat absence as `not_available`.
   */
  insights?: PlatformInsightsEnvelope;
  /**
   * Advisory LLM graders on this run, keyed by judge. Present on the DETAIL
   * response only (lists stay compact) and absent on API deployments that
   * predate the envelope.
   */
  judges?: PlatformEvalRunJudges;
  /**
   * Whether this run's imported cases carry evidence a gate may rely on.
   *
   * ABSENT means an API deployment that predates import eligibility — a
   * different fact from `legacy`, and one a gate must treat as "no opinion,
   * behave as before" rather than as "no imported cases". Present on the
   * detail response; lists stay compact.
   */
  importEligibility?: PlatformImportEligibility;
}

/**
 * The advisory graders that can run against a finished eval run. An envelope
 * rather than a bare `judge` field because `goalCompletion` is one of several:
 * `groundedness` sits beside it, and a future judge is a new key here rather
 * than a reshaped response. A judge absent from this object is one this
 * deployment does not have.
 */
export interface PlatformEvalRunJudges {
  /** Grades each case's final answer against its expected output. */
  goalCompletion?: PlatformEvalRunGoalCompletionJudge;
  /** Grades whether each answer is SUPPORTED by its tool trajectory. */
  groundedness?: PlatformEvalRunGroundednessJudge;
}

/**
 * State every judge reports. Written as a base each judge EXTENDS rather than a
 * generic: the per-judge `cases` differ in shape, and spelling each judge out
 * keeps the wire schema checkable field by field.
 */
export interface PlatformEvalRunJudgeState {
  /**
   * `null` means the judge was NEVER requested for this run — a different
   * answer from "requested and produced nothing". Poll rather than
   * re-requesting while this is `"pending"`.
   */
  status: "pending" | "completed" | "failed" | null;
  /** Machine-readable failure reason, set alongside `status: "failed"`. */
  errorCode: string | null;
  summary: string | null;
  generatedAt: number | null;
  modelUsed: string | null;
  /** Pass threshold the results were scored against (`passed = score >= it`). */
  threshold: number | null;
}

export interface PlatformEvalRunGoalCompletionJudge
  extends PlatformEvalRunJudgeState {
  /**
   * Per-case grades. EMPTY unless `status` is `"completed"` — a pending or
   * failed judge carries no cases, and `status` is what says which.
   */
  cases: PlatformEvalRunGoalCompletionCase[];
}

export interface PlatformEvalRunGroundednessJudge
  extends PlatformEvalRunJudgeState {
  /** Per-case grades. EMPTY unless `status` is `"completed"`. */
  cases: PlatformEvalRunGroundednessCase[];
}

/** Shared per-case fields every judge reports. */
export interface PlatformEvalRunJudgeCase {
  /**
   * The stable AUTHORED-case identity, as persisted. NOT a case row id — do
   * not join it against the ids the per-case routes take.
   */
  caseKey: string;
  /**
   * The iteration this case graded — the join key between a judge case and
   * the iterations the run returns, since `caseKey` is a storage key and
   * joins to nothing.
   *
   * Optional because judge results written before it was persisted carry
   * none: a caller must be able to tell "this run predates the join key"
   * from a value it could act on.
   */
  iterationId?: string;
  score: number | null;
  passed: boolean;
  reason: string | null;
}

export interface PlatformEvalRunGoalCompletionCase
  extends PlatformEvalRunJudgeCase {
  /** Rubric criteria the answer satisfied. */
  rubricHits: string[];
}

export interface PlatformEvalRunGroundednessCase
  extends PlatformEvalRunJudgeCase {
  /** Claims the tool trajectory does not support. */
  unsupportedClaims: string[];
}

// ── Pre-run disclosure ───────────────────────────────────────────────────
//
// Hand-mirrored from the backend's `RunDisclosure` contract
// (mcpjam-backend `convex/lib/evalDisclosure.ts`), field names identical on
// purpose — this is the one copy the SDK keeps in sync by hand rather than
// importing, since the backend module is server-only. `execution.locus` is
// the one field the backend cannot fill in itself (see
// `PlatformEvalRunDisclosureLocus`); everything else here is a direct
// projection of what `GET /projects/{p}/eval-suites/{id}/run-disclosure`
// returns.

/** The closed set `resolveChatProvider` can return, named so a surface can
 * exhaust it. */
export type PlatformDisclosureRailDestination = "gateway" | "openrouter";

export interface PlatformManagedRailDisclosure {
  managed: true;
  possibleDestinations: readonly PlatformDisclosureRailDestination[];
  /** VOLATILE: the routing mode is read per request, so this can differ from
   * the destination the run actually uses minutes later. */
  outcomeIfRunNow: {
    destination: PlatformDisclosureRailDestination;
    observedAt: number;
    volatile: true;
  };
  inputs: {
    mode: string;
    gatewayEligible: boolean;
    hasOpenRouterFallback: boolean | null;
  };
  ruleLocation: string;
  authoritativePerRequestRecord: string;
}

export interface PlatformNotApplicableRailDisclosure {
  managed: false;
  notApplicable: true;
  reason: string;
  authoritativePerRequestRecord: string;
}

export type PlatformRailDisclosure =
  | PlatformManagedRailDisclosure
  | PlatformNotApplicableRailDisclosure;

export type PlatformDisclosureTenantEgress =
  | "mcpjam-hosted"
  | "byok-cloud"
  | "byok-local"
  | "unknown";

export interface PlatformByokDisclosure {
  providerKey: string;
  runtimeLocation: "cloud" | "local";
  /** HOST ONLY, never the full configured URL. */
  baseUrlHost?: string;
}

export interface PlatformDisclosedModel {
  modelId: string;
  /** `null` when the classifier declines to classify. Kept as `string` rather
   * than a closed union so a newly recognised provider on the backend does
   * not need a matching SDK release to pass through. */
  provider: string | null;
  customProviderName?: string;
  tenantEgress: PlatformDisclosureTenantEgress;
  byok?: PlatformByokDisclosure;
  rail: PlatformRailDisclosure;
}

/**
 * The closed value set of `execution.engine`. `'mixed'` is reachable only on
 * an environment fan-out that resolved more than one distinct engine —
 * `engines` then carries the per-plan detail and `'mixed'` is a summary, not
 * a fourth runtime kind.
 */
export type PlatformDisclosureEngine =
  | "emulated"
  | "mixed"
  | `harness:${string}`;

/**
 * Whether this run executes MCPJam-hosted or on the caller's own machine.
 *
 * RESERVED for the inspector to fill in: the backend contract cannot answer
 * this (only the executing process knows), so the inspector route composes
 * it onto every `execution` section it returns. `known: false` is kept in
 * the union defensively — a caller MUST NOT treat it as `hosted: false`.
 */
export type PlatformEvalRunDisclosureLocus =
  | { known: true; hosted: boolean }
  | { known: false; reason: string };

export interface PlatformExecutionDisclosure {
  engine: PlatformDisclosureEngine;
  engines?: readonly PlatformDisclosureEngine[];
  sandbox: {
    engaged: boolean;
    vendor?: "e2b";
    because: string;
  };
  locus: PlatformEvalRunDisclosureLocus;
  models: readonly PlatformDisclosedModel[];
  /** Present when the plan resolved but its models did not — the empty list
   * then reads as "not derivable here" rather than "no model runs". */
  modelsUnresolved?: { reason: string };
}

export type PlatformEvalLlmTouchpointId =
  | "goalCompletion"
  | "groundedness"
  | "serverQuality"
  | "runInsights"
  | "runGroupQuality";

export type PlatformDisclosureFires =
  | "auto-on-completion"
  | "explicit-request-only"
  | { disabled: true; reason: string };

export interface PlatformAnalysisTouchpointDisclosure {
  touchpoint: PlatformEvalLlmTouchpointId;
  label: string;
  model: string;
  rail: { fixed: "openrouter"; because: string };
  destinations: readonly string[];
  evidenceSent: readonly string[];
  fires: PlatformDisclosureFires;
}

export interface PlatformCaptureDisclosure {
  captureLevel: string;
  reportingMode: string;
  tiersImplemented: boolean;
  redaction: {
    kind: string;
    module: string;
    isDlp: boolean;
    limitation: string;
    appliesTo: readonly string[];
  };
  exportDefaults: {
    includeContent: boolean;
    ruleLocation: string;
    note: string;
  };
}

export interface PlatformRetentionDisclosure {
  planName: string;
  /** The POLICY number from plan entitlements. `null` ⇒ uncapped by policy. */
  policyDays: number | null;
  source: string;
  enforced: boolean;
  enforcementBlockers: readonly string[];
  /** What actually happens today — never re-derive this from `policyDays`,
   * an unenforced policy keeps data indefinitely regardless of its number. */
  effectiveToday: "kept-indefinitely" | "swept-after-policy-days";
  evidentiaryClasses: readonly string[];
  backupStatement: {
    vendor: string;
    capturedAt: string;
    sourceUrl: string;
    statements: readonly string[];
  };
}

export type PlatformRegionDisclosure =
  | { stated: false; reason: string }
  | { stated: true; value: string; derivedFrom: string };

export interface PlatformSubprocessorDisclosure {
  vendor: string;
  role: string;
  dataCategories: readonly string[];
  capturedAt: string;
  sourceUrl: string;
  statements: readonly string[];
  engaged: boolean;
  because: string;
}

/**
 * WHY there is no `execution` section. Never interchangeable:
 *  * `'ingested-run'` — the SDK uploaded a run MCPJam did not execute;
 *  * `'plan-unresolved'` — a launchable plan whose environments did not
 *    resolve, so models ARE called, just not derivable at this point.
 *
 * A surface that renders `'ingested-run'` copy for a `'plan-unresolved'`
 * disclosure tells a user about to launch that nothing leaves — that exact
 * bug was caught and fixed in the backend half (g4a) and must not be
 * reintroduced at the presentation layer.
 */
export type PlatformExecutionAbsenceKind = "ingested-run" | "plan-unresolved";

/**
 * The pre-run disclosure contract: what happens to a run's content, computed
 * once by the backend and projected identically by every surface (pre-run
 * dialog, CLI, MCP tools, the `eval.run.launched` audit row).
 *
 * `execution` is present ONLY when a launch plan resolved; `executionAbsence`
 * exactly when it is absent. `analysis` is ALWAYS present — stored evidence
 * still reaches the judges even when nothing was executed here — so never
 * hide it just because `execution` is missing.
 */
export interface PlatformEvalRunDisclosure {
  contractVersion: number;
  computedAt: number;
  digest: string;
  execution?: PlatformExecutionDisclosure;
  executionAbsence?: { kind: PlatformExecutionAbsenceKind; reason: string };
  analysis: readonly PlatformAnalysisTouchpointDisclosure[];
  capture: PlatformCaptureDisclosure;
  retention: PlatformRetentionDisclosure;
  region: PlatformRegionDisclosure;
  subprocessors: readonly PlatformSubprocessorDisclosure[];
}

/**
 * Identity of the environment revision a run was pinned to. `name`/`revision`
 * are nullable only for tolerance of older snapshots that recorded a partial
 * ref; a current run always carries all three.
 */
export interface PlatformEvalRunEnvironment {
  id: string;
  name: string | null;
  revision: number | null;
}

/** `202` response of `POST /projects/{p}/eval-runs`. */
export interface PlatformEvalRunCreated {
  runId: string;
  suiteId: string;
  /**
   * The run's status. `running` on a fresh launch; on a replay (see
   * `deduped`), the existing run's own status — which may already be terminal.
   */
  status: string;
  /**
   * This request REPLAYED an existing run rather than starting one — an
   * idempotency-key hit, or the short keyless dedupe window.
   *
   * A replayed run is NOT executed again, so a retry spends nothing further.
   * Absent on a fresh launch, and on an API deployment that predates the
   * signal — where absence means "not reported", not "fresh".
   */
  deduped?: boolean;
  /**
   * Echo of the request's `runGroupId`, when one was sent. A LABEL only — it
   * groups sibling rows for display and carries no quota or launch semantics.
   * Grouped-launch behaviour (one concurrency slot for a whole fan-out,
   * validate-all-then-launch) lives on `createEvalRunGroup`, which mints the
   * id itself. Absent when the request sent none, and on older deployments.
   */
  runGroupId?: string;
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
  /**
   * The environment the run is pinned to, at the revision whose servers were
   * connected. Present even when the request omitted it: a suite with exactly
   * one attached environment auto-selects, and this is how a caller learns
   * that happened. `null` for a legacy run; absent on older API deployments.
   */
  environment?: PlatformEvalRunEnvironment | null;
}

/** Which target one entry of a grouped launch ran. Exactly one id is set. */
export interface PlatformEvalRunGroupTarget {
  environmentId?: string;
  namedHostId?: string;
  /** The target's display name, when the platform resolved one. */
  name?: string;
}

/**
 * One target's outcome in a grouped launch.
 *
 * DISCRIMINATED on `status` rather than "a runId when it worked, an error when
 * it didn't": a reader branches on one field instead of probing which optional
 * members happen to be present, and a target that failed can never be mistaken
 * for one that started with an unread `runId`.
 */
export type PlatformEvalRunGroupEntry =
  | {
      status: "started";
      target: PlatformEvalRunGroupTarget;
      runId: string;
      /**
       * The RUN's status (always `"running"` at launch). Named apart from the
       * entry's own `status` on purpose — two fields called `status` in one
       * object is how a reader ends up branching on the wrong one.
       */
      runStatus: string;
      servers?: Array<{ id: string; name?: string }>;
      environment?: PlatformEvalRunEnvironment | null;
      caseUpsert?: PlatformEvalRunCreated["caseUpsert"];
    }
  | {
      status: "failed";
      target: PlatformEvalRunGroupTarget;
      error: { code: string; message: string };
    };

/**
 * The receipt for `POST /eval-run-groups`: one run per target, under one
 * server-minted group id.
 *
 * A per-target failure does NOT abort its siblings, so a caller must read
 * `outcome` rather than assume a 202 means everything started.
 */
export interface PlatformEvalRunGroupCreated {
  runGroupId: string;
  suiteId: string;
  /**
   * `"started"` — every target launched; `"partial"` — some did and some did
   * not; `"failed"` — none did (still a 202: the group itself was valid, and
   * the per-target reasons are in `targets`).
   */
  outcome: "started" | "partial" | "failed";
  startedCount: number;
  failedCount: number;
  targets: PlatformEvalRunGroupEntry[];
  /**
   * @deprecated Mirror of the FIRST started run, so readers written against
   * the single-run receipt keep working. Absent when nothing started. Read
   * `targets` instead — this describes one run out of several.
   */
  runId?: string;
  /** @deprecated See `runId`. */
  status?: string;
  /** @deprecated See `runId`. */
  servers?: Array<{ id: string; name?: string }>;
  /** @deprecated See `runId`. */
  environment?: PlatformEvalRunEnvironment | null;
  /** @deprecated See `runId`. */
  caseUpsert?: PlatformEvalRunCreated["caseUpsert"];
}

/**
 * `201` response of `POST /projects/{p}/eval-suites` — an authored, runnable
 * suite created from test-case definitions (NOT run; execute it with
 * `run_eval_suite`). Tolerant reader: unknown fields pass through.
 */
export interface PlatformEvalSuiteCreated {
  suiteId: string;
  /** Suite name as persisted; echoes the request name. */
  name: string;
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
  /**
   * Suite-level FLOOR on per-case iterations, 1–10: every case runs at least
   * this many times (`max(case.iterations, minimumIterations)`). `null` means
   * no floor — the suite's real state, not a stand-in for 1. Absent on older
   * API deployments.
   */
  minimumIterations?: number | null;
  matchOptions: PublicMatchOptions | null;
  checks: PublicCheck[];
  /**
   * LLM-as-judge configuration, RESOLVED — every field is layered over the
   * platform defaults, so this is what a run on this suite would actually
   * grade with.
   *
   * `model` stays nullable: older API deployments report the suite's raw
   * `judgeModel`, which is `null` for a suite that never picked one.
   */
  judge: {
    /** Judge is available on the suite. Does NOT by itself grade anything. */
    enabled: boolean;
    model: string | null;
    /**
     * The flag that makes grading HAPPEN — fires the judge as each run
     * completes. Absent on older API deployments.
     */
    autoRun?: boolean;
    /**
     * Advisory pass threshold (`passed = score >= threshold`), in [0, 1].
     * Absent on older API deployments.
     */
    threshold?: number;
  };
  /**
   * The verdict policy this suite's runs are decided under.
   *
   * `2` is the fraction-and-validity policy: each case is graded against a
   * `passThreshold` FRACTION over its own `repetitions`, and a run is decided
   * valid-first (an invalid run is `"inconclusive"`, not failed).
   *
   * ABSENT means legacy: runs are graded by `minimumAccuracy` (a suite-wide
   * PERCENT) over `max(case.iterations, minimumIterations)`. The two are not
   * convertible, which is why absence is reported rather than defaulted —
   * reading a historical percent as a fraction silently moves every bar.
   */
  verdictPolicyVersion?: 2;
  /**
   * Suite defaults a case inherits under policy 2. Present only with
   * `verdictPolicyVersion: 2`, and only as a whole: `repetitions` without
   * `passThreshold` cannot answer what a case is graded against.
   */
  verdictPolicyDefaults?: PlatformEvalVerdictPolicyDefaults;
}

/** Suite-level defaults under verdict policy 2. Fractions, never percents. */
export interface PlatformEvalVerdictPolicyDefaults {
  /** Trials per case unless the case overrides `repetitions`. */
  repetitions: number;
  /** Fraction of a case's trials that must pass, in [0, 1]. */
  passThreshold: number;
  /**
   * When a run's measurement counts as trustworthy enough to decide.
   *
   * DECLARED, not resolved: an omitted field is not "no minimum" but the
   * contract's default — `minCompletionRate` 0.8, `maxEvaluatorErrorRate` 0.1,
   * and an omitted `minEligibleTrials` requiring every configured trial
   * attempted plus at least one gradeable trial. The resolved policy a run was
   * actually decided under is on the run's `verdictSummary.validity`.
   */
  validity?: {
    minEligibleTrials?: number;
    minCompletionRate?: number;
    maxEvaluatorErrorRate?: number;
  };
}

/** The sandbox image a suite's eval runs boot from. */
export interface PlatformEvalSuiteComputerEnvironment {
  id: string;
  /** `null` when the pinned image could not be resolved. */
  name: string | null;
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
  /**
   * The single attached environment scheduled runs launch (a schedule fires one
   * run, so a multi-environment suite must pin one). `null` for a legacy suite;
   * absent on older API deployments.
   */
  environmentId?: string | null;
}

/**
 * Full eval suite, returned by `GET`/`PATCH /eval-suites/{id}`. Public-model
 * shape — the route layer maps this to/from the internal Convex suite. Tolerant
 * reader: unknown fields pass through.
 */
export interface PlatformEvalSuiteDetail {
  id: string;
  /**
   * The suite's declared file identity (`suite.id` in a suite file). Present
   * on file-owned suites; absent on UI-authored suites, which have no
   * declared id and cannot be claimed by `eval run --file`.
   */
  declaredId?: string;
  name: string | null;
  description: string | null;
  projectId: string | null;
  /** LEGACY server selection by name. Not the project-environment attachments. */
  environment: {
    servers: string[];
    /**
     * The custom sandbox image this suite's eval runs boot a fresh computer
     * from. `null` means the provider's default base image. The `name` is the
     * one `list_sandbox_images` reports; it is `null` when the image could not
     * be resolved (deleted, or not visible to this caller). Absent on older
     * API deployments.
     */
    computerEnvironment?: PlatformEvalSuiteComputerEnvironment | null;
  };
  /**
   * Attached project environments, in attach order. A non-empty list makes the
   * suite environment-based: its runs resolve one of these instead of the
   * legacy selection above. Absent on older API deployments.
   */
  environmentIds?: string[];
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

/**
 * `POST /eval-suites/from-file` — resolve or create a file-owned suite by
 * declared id. `created` is true on the first upload of that id in the
 * project; later uploads update the same suite.
 */
export interface PlatformFileOwnedEvalSuiteSynced {
  created: boolean;
  suite: PlatformEvalSuiteDetail;
}

export interface PlatformEvalCaseModel {
  model: string;
  provider?: string;
}

/**
 * One authored test step — the unified test model (mirrors the inspector's
 * `shared/steps.ts` `TestStep`). Typed permissively at this boundary
 * (discriminated on `kind`); per-kind detail fields ride along.
 *
 * REPLACES the old per-case `kind` / `prompt` / `turns` / `expectedToolCalls`
 * / `renderCheck` projection (Phase 2.5 clean break).
 */
export interface PlatformEvalStep {
  id: string;
  kind: "prompt" | "toolCall" | "interact" | "assert";
  [field: string]: unknown;
}

/**
 * A single eval test case. The case body is an ordered `steps` array
 * (prompt / toolCall / interact / assert). Public-model shape; the route maps
 * to/from the internal case.
 */
export interface PlatformEvalCase {
  id: string;
  /**
   * The case's effective DECLARED id — what it answers to in a suite file, an
   * import, or a CLI argument. Absent on cases authored before declared
   * identity existed. Distinct from `id`, which is the platform row id the
   * per-case routes take as their path parameter.
   */
  declaredId?: string;
  title: string;
  /** Optional authored analytics grouping label; absent is unlabelled. */
  intent?: string;
  /** Ordered test steps that define the case. */
  steps: PlatformEvalStep[];
  expectedOutput?: string;
  /** Iterations to run per eval run (← internal runs). */
  iterations: number;
  /**
   * Trials this case runs under verdict policy 2, overriding the suite
   * default. Absent means the case inherits it.
   *
   * NOT a second spelling of `iterations`: that one is the legacy count, which
   * the legacy resolver reads as a FLOOR (`max(iterations, minimumIterations)`)
   * and which a policy-2 case still reports for compatibility. This one is
   * exact.
   */
  repetitions?: number;
  /**
   * Fraction of this case's trials that must pass, in [0, 1], overriding the
   * suite default. Absent means the case inherits it.
   *
   * Never derived from the suite's `minimumAccuracy`, which is a percent under
   * a different resolver.
   */
  passThreshold?: number;
  isNegative: boolean;
  scenario?: string;
  /** Execution models (plural — preserves compare behavior). */
  models: PlatformEvalCaseModel[];
  matchOptions?: PublicMatchOptions;
  checks?: PublicCheckOverride;
  /**
   * The converter's CLAIM about this case, when it was imported rather than
   * authored here. ABSENT means natively authored — a different fact from
   * "imported, faithfulness unknown", and one nothing downstream can recover
   * once the two are conflated.
   */
  import?: PlatformEvalCaseImportClaim;
  createdAt: number | null;
  updatedAt: number | null;
}

/**
 * What a converter CLAIMED about one imported case.
 *
 * `exact` is CONVERTER-CLAIMED exact: the converter says it applied a
 * structural mapping rule, cited in `note`. MCPJam has NOT verified semantic
 * equivalence and this field is not evidence that it did — user-facing copy
 * must say "claimed exact", never "verified" or "accepted".
 *
 * Claim-only in both directions. Who approved an approximation, when, and why
 * is a PER-RUN decision that lives on the run's frozen snapshot
 * ({@link PlatformImportApprovalReceipt}), never on the case: an approval
 * stored on a case would outlive the run it was granted for and the edit that
 * invalidated it.
 *
 * ALIASED to the suite-file contract's own type rather than restated. A claim a
 * converter writes into a file is exactly a claim the API carries, so a second
 * spelling here is only an opportunity for the two to disagree about what a
 * claim is — and the disagreement would surface at somebody's ingest, not ours.
 */
export type PlatformEvalCaseImportClaim = EvalSuiteFileCaseImport;

/**
 * One frozen approval of an approximated import, as the run recorded it.
 *
 * Every field here was written by the SERVER at launch. The launcher supplied
 * a case id and a reason; the actor and the timestamp were derived, and the
 * whole record was frozen into the run's own case snapshot. Reading it back
 * therefore tells you what was true at launch, which is the only question a
 * receipt can honestly answer — never what the case's current claim says.
 */
export interface PlatformImportApprovalReceipt {
  testCaseId: string;
  caseKey?: string;
  sourceCaseKey?: string;
  approvedBy: string;
  approvedAt: number;
  reason: string;
}

/** One reason a run's import evidence is incomplete. */
export interface PlatformImportEligibilityIssue {
  /** Stable machine-readable code from the platform. */
  code: string;
  testCaseId?: string;
  caseKey?: string;
  toolName?: string;
}

/**
 * Whether a run's imported cases carry evidence a gate may rely on.
 *
 * Computed by the platform from the run's OWN frozen snapshot, never from the
 * suite's current cases — those can be edited after the run, and recomputing
 * from them would let an edit retroactively change what a finished run is
 * allowed to prove.
 *
 * The three states are not two:
 *
 *   - `legacy` — the run contains no imported cases at all. Every pre-import
 *     run, and every native run forever. Gateable, behaviour unchanged.
 *   - `eligible` — imported cases, every one carrying a valid frozen decision.
 *   - `incomplete` — imported evidence that cannot be trusted. NOT a failure:
 *     the run is simply not gateable, and reporting it as a failed verdict
 *     would describe a server defect the run never observed.
 */
export interface PlatformImportEligibility {
  status: "legacy" | "eligible" | "incomplete";
  gateable: boolean;
  importedCaseCount: number;
  claimedExactCaseIds: string[];
  approvedApproximationCaseIds: string[];
  approvedApproximationReceipts: PlatformImportApprovalReceipt[];
  issues: PlatformImportEligibilityIssue[];
}

/** A note about a batch write that changes nothing about what was written. */
export interface PlatformEvalCaseWarning {
  /** Stable machine-readable code (e.g. `DUPLICATE_POLICY_COERCED`). */
  code: string;
  message: string;
}

/** One case a batch create authored. */
export interface PlatformEvalCaseBatchCreated {
  /** Position in the `cases` array that was sent. */
  index: number;
  /** Platform id — what the per-case routes take as their path parameter. */
  id: string;
  /** The effective declared id. On a replay this is the STORED case's. */
  declaredId?: string;
  title: string;
  /** True when an idempotent retry landed on an already-authored case. */
  replayed: boolean;
  warnings?: PlatformEvalCaseWarning[];
}

/** One case a batch create refused. Its siblings may still have committed. */
export interface PlatformEvalCaseBatchFailed {
  index: number;
  title?: string;
  declaredId?: string;
  /** Stable machine-readable code (e.g. `DUPLICATE_CASE_ID`). */
  code: string;
  message: string;
}

/**
 * The result of authoring several cases at once.
 *
 * Per-case failures are reported here rather than raised: a batch is a partial
 * outcome by design, and the cases in `created` were really written.
 */
export interface PlatformEvalCaseBatchResult {
  created: PlatformEvalCaseBatchCreated[];
  failed: PlatformEvalCaseBatchFailed[];
  /**
   * What duplicate policy actually applied. An unrecognized value coerces to
   * `block` and says so here — never silently.
   */
  duplicatePolicy: {
    requestedPolicy?: string;
    effectivePolicy: string;
    coerced: boolean;
  };
  warnings?: PlatformEvalCaseWarning[];
}

// ── Run comparison ───────────────────────────────────────────────────────────
//
// The public projection of the backend's run diff. Three naming decisions are
// load-bearing and deliberate:
//
//   1. The internal diff's top-level `scores` is run-summary COUNTERS, and it
//      collides by name with score-contract data. On this wire it is
//      `passSummary`, and the word "scores" appears only inside
//      `scoreContract` / `scoreDeltas`.
//   2. `traceBlobIds` never crosses this boundary. The internal diff carries
//      `_storage` ids; the DTO whitelist drops them.
//   3. New rate fields are FRACTIONS and carry no `Percent` in the name. The
//      one legacy percent field keeps its name so nobody mistakes it.

/** A base/compare pair with its delta. Rates in these are fractions. */
export interface PlatformNumericDiff {
  base: number | null;
  compare: number | null;
  delta: number | null;
  percentDelta: number | null;
}

export type PlatformCompareCaseStatus =
  | "unchanged_passed"
  | "unchanged_failed"
  | "regressed"
  | "fixed"
  | "new_case"
  | "removed_case"
  | "changed";

export interface PlatformScoreContractSide {
  evaluationConfigHash: string | null;
  /** `null` means NO verdict — treat it exactly like `"invalid"` for gating. */
  scoreIntegrity: "valid" | "invalid" | null;
  scoredIterations: number;
  quarantinedIterations: number;
}

export interface PlatformScoreContractScorer {
  scorerId: string;
  gating: boolean;
  deterministic: boolean;
  /** Same id, different definition hash — the two sides did not measure alike. */
  definitionChanged: boolean;
  passRate: PlatformNumericDiff;
  meanValue: PlatformNumericDiff;
  errorCount: { base: number; compare: number };
}

export interface PlatformScoreContractDiff {
  base: PlatformScoreContractSide;
  compare: PlatformScoreContractSide;
  evaluationConfigChanged: boolean;
  scorers: PlatformScoreContractScorer[];
}

export interface PlatformCaseScoreSide {
  status: "scored" | "error" | "skipped" | "not_applicable";
  value: number | null;
  passed: boolean | null;
}

export interface PlatformCaseScoreDelta {
  scorerId: string;
  gating: boolean;
  deterministic: boolean;
  definitionChanged: boolean;
  base: PlatformCaseScoreSide | null;
  compare: PlatformCaseScoreSide | null;
  value: PlatformNumericDiff;
}

export interface PlatformRunCompareCaseSide {
  outcome: "passed" | "failed" | "absent";
  /** Iteration ids are public; `traceBlobIds` are NOT and never appear here. */
  iterationIds: string[];
  representativeIterationId: string | null;
  error: string | null;
}

export interface PlatformRunCompareCase {
  caseKey: string;
  title: string;
  status: PlatformCompareCaseStatus;
  /** The scenario's own config (prompt, steps, expectations) changed. */
  configChanged: boolean;
  /** This case's evaluation config changed. */
  evaluationConfigChanged: boolean;
  scoreDeltas: PlatformCaseScoreDelta[];
  base: PlatformRunCompareCaseSide;
  compare: PlatformRunCompareCaseSide;
}

export interface PlatformRunCompareSide {
  id: string;
  runNumber: number;
  result: string;
  createdAt: number;
  completedAt: number | null;
  summary: {
    total: number;
    passed: number;
    failed: number;
    passRate: number;
  } | null;
  environment?: { id: string; name: string | null };
  effectiveModelId?: string;
  modelSource?: "client_default" | "override";
}

/**
 * The compare wire.
 *
 * There is deliberately NO `baseline_not_found` member. A missing baseline
 * arrives as a thrown `PlatformApiError` (404 with
 * `details.reason === "BASELINE_NOT_FOUND"`), so a caller that forgets to
 * handle it fails loudly instead of reading fields off a union member it never
 * narrowed.
 */
export interface PlatformRunCompare {
  suite: { id: string; name: string };
  baseline: {
    policy:
      | "previous_completed"
      | "previous_completed_same_environment"
      | "run"
      | "commit_sha";
    baseRunId: string;
    /**
     * The source SHA that was pinned, echoed back for the `commit_sha` policy
     * only. Recorded alongside `baseRunId` rather than instead of it: a gate's
     * audit trail needs both the SHA the caller asked for and the run it
     * actually resolved to.
     */
    baseCommitSha?: string;
    /**
     * Present ONLY when uniqueness could NOT be established — the SHA matched
     * several eligible runs, or the bounded lookup saturated so older eligible
     * ones may exist beyond it. **Absent means unambiguous**; do not default
     * it to 1.
     */
    matchCount?: number;
    /**
     * `matchCount` is a FLOOR, not a total — including when it reads 1. Render
     * it WITH its count or not at all: a truncated count shown alone asserts a
     * uniqueness nobody checked.
     */
    matchCountTruncated?: boolean;
  };
  baseRun: PlatformRunCompareSide;
  compareRun: PlatformRunCompareSide;
  /**
   * Run-summary counters — NOT score-contract data. Named `passSummary` here
   * precisely because the internal field is called `scores` and the collision
   * is a live foot-gun.
   */
  passSummary: {
    passRatePercent: PlatformNumericDiff;
    total: PlatformNumericDiff;
    passed: PlatformNumericDiff;
    failed: PlatformNumericDiff;
  };
  metrics: {
    wallDurationMs: PlatformNumericDiff;
    totalTokens: PlatformNumericDiff;
    estimatedCostUsd: PlatformNumericDiff;
  };
  scoreContract: PlatformScoreContractDiff;
  /**
   * Which skills changed between the two runs — the configuration attribution
   * that usually explains the case-level differences beside it.
   *
   * Three states, and they mean different things:
   *   - a section — these skills changed (or none did, with a count);
   *   - `null` — NEITHER run recorded pinned skills, so there is nothing to
   *     say; an empty section would claim no skills were involved;
   *   - ABSENT — the deployment answering predates skill attribution entirely.
   *     Optional for that reason: a client cannot assume every backend it talks
   *     to has this, and a required field would make old responses unusable.
   */
  skills?: PlatformRunCompareSkills | null;
  cases: PlatformRunCompareCase[];
}

/** Delivery channel a pinned skill reached a run through. */
export type PlatformRunCompareSkillChannel =
  | "host"
  | "environment"
  | "plugin"
  | "mcp-server";

/** One skill's identity + content fingerprint on one side of a comparison. */
export interface PlatformRunCompareSkillSide {
  contentHash: string;
  /** Complete-artifact hash; present only when supporting files diverge it. */
  aggregateHash?: string;
  /** Authored-skill revision, when the run recorded one. */
  versionNumber?: number;
  /** MCP-captured revision, when the run recorded one. */
  serverSkillVersionNumber?: number;
}

export interface PlatformRunCompareSkillChange {
  /** Stable match key; opaque, safe for list keys and dedupe. */
  key: string;
  name: string;
  /** Namespaced runtime address for a plugin-channel skill. */
  modelRef?: string;
  channels: PlatformRunCompareSkillChannel[];
  kind: "added" | "removed" | "changed";
  /** Renamed between the runs — matched as ONE skill by its logical id. */
  renamedFrom?: string;
  base?: PlatformRunCompareSkillSide;
  compare?: PlatformRunCompareSkillSide;
  /**
   * `v3 → v4`, present only when BOTH sides recorded a revision number. A
   * change with no delta is a real content change whose revisions are unknown
   * (one side predates versioning) — not a smaller change.
   */
  versionDelta?: string;
}

export interface PlatformRunCompareSkills {
  base: { excluded: boolean; count: number };
  compare: { excluded: boolean; count: number };
  /** Added / removed / changed only, changed first. Unchanged are counted. */
  changes: PlatformRunCompareSkillChange[];
  unchangedCount: number;
}

export interface PlatformEvalSuiteDeleted {
  id: string;
  deleted: true;
}

export interface PlatformEvalCaseDeleted {
  id: string;
  deleted: true;
}

// ── Clients ──────────────────────────────────────────────────────────────────
//
// A **Client** is the product noun: a named, reusable configuration that
// defines how MCPJam connects to and talks to your MCP servers. The
// `PlatformHost*` types below it are the DEPRECATED shapes the `/hosts` alias
// still returns. They are separate interfaces, not aliases of these, because
// the two surfaces genuinely differ in their fields — see the note on
// `PlatformHost`.

/**
 * What a config edit to a client would follow.
 *
 * These are the DURABLE consumers that re-resolve the client's current config.
 * Past runs, per-turn traces and pinned eval-suite snapshots hold a config id
 * and do not follow an edit. Direct playground / client-chat use follows it and
 * has no row to count, which is why it is described in prose by the surfaces
 * that quote these numbers rather than folded into one of them.
 */
export interface PlatformClientImpact {
  liveEnvironmentCount: number;
  scenarioAttachmentCount: number;
  activeLegacyJourneyCount: number;
}

/** A client in a project (list projection). */
export interface PlatformClient {
  id: string;
  name: string;
  /**
   * ID of the content-addressed config this client points at, and the
   * concurrency token every write takes. Content addressed, so the same id
   * means byte-identical settings.
   */
  configId: string;
  modelId: string;
  serverCount: number;
  /** Product ownership of the row (null for untagged). Never an auth signal. */
  ownerScope: Record<string, unknown> | null;
  hasComputer: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Full client detail, including the resolved config DTO and its read-backs. */
export interface PlatformClientDetail {
  id: string;
  name: string;
  /** The concurrency token — see {@link PlatformClient.configId}. */
  configId?: string;
  /** Resolved client-config v2 DTO (model, capabilities, hostContext, …). */
  config: Record<string, unknown>;
  ownerScope: Record<string, unknown> | null;
  hasComputer?: boolean;
  createdAt?: number;
  updatedAt?: number;
  /** What a config edit would follow. */
  impact?: PlatformClientImpact;
}

export interface PlatformClientDeleted {
  id: string;
  deleted: true;
}

/**
 * @deprecated A host in a project, as the `/hosts` alias returns it. Use
 * {@link PlatformClient}.
 *
 * NOT a type alias of `PlatformClient`, deliberately. `/hosts` returns
 * `hostConfigId` where `/clients` returns `configId`, and carries none of the
 * read-backs — so an alias would be a compile-time lie about a runtime shape,
 * and every existing caller reading `hostConfigId` would start failing
 * typecheck for a field the deprecated route still sends.
 */
export interface PlatformHost {
  id: string;
  name: string;
  hostConfigId: string;
  modelId: string;
  serverCount: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * @deprecated Full host detail as the `/hosts` alias returns it. Use
 * {@link PlatformClientDetail}, which also carries `configId` and `impact`.
 */
export interface PlatformHostDetail {
  id: string;
  name: string;
  /** Resolved host-config v2 DTO (model, capabilities, hostContext, …). */
  config: Record<string, unknown>;
}

/** @deprecated Use {@link PlatformClientDeleted}. */
export interface PlatformHostDeleted {
  id: string;
  deleted: true;
}

// ── Project Environments ─────────────────────────────────────────────────────
//
// A named, project-scoped, live-editable execution bundle that eval suites and
// journeys run against: one host, an optional standalone server group, an
// optional pinned skill selection, and optional pinned plugin versions.
//
// NOT a `PlatformImage` (a Computer sandbox base image), and not the eval-suite
// `environment` servers bag — this is the concept that owns the word.
//
// Environments are REVISIONED for optimistic concurrency: every mutation takes
// the `expectedRevision` you last read, and a stale value is rejected with 409
// CONFLICT rather than clobbering a concurrent edit.

/**
 * An explicit, pinned skill selection. Empty lists are rejected — clear the
 * field (`null` on update) to mean "no pinned skills".
 */
export interface PlatformEnvironmentSkillSelection {
  mode: "explicit";
  skillIds: string[];
  /**
   * EXACT-version overlay. At most one entry per selected skill; a selected
   * skill with no entry resolves "Latest" — its current revision, read when the
   * run starts, which is what every environment did before pins existed and
   * what omitting this field still means.
   *
   * Pin a version to hold an environment at a known revision — the way two
   * environments run two revisions of one skill side by side for a comparison.
   */
  versionPins?: PlatformEnvironmentSkillVersionPin[];
}

export interface PlatformEnvironmentSkillVersionPin {
  skillId: string;
  versionId: string;
}

export interface PlatformEnvironment {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  hostId: string;
  /** Set only when the environment pins a standalone server group. */
  serverAttachmentId?: string;
  /**
   * The environment's model OVERRIDE, if it sets one.
   *
   * ABSENT means the environment INHERITS the model pinned by its host — not
   * that it has no model. To learn what will actually run, resolve the
   * environment and read `effectiveModelId`.
   */
  modelId?: string;
  skillSelection?: PlatformEnvironmentSkillSelection;
  secretSelection?: PlatformEnvironmentSecretSelection;
  /**
   * Pinned plugin VERSIONS. Narrow by design: a version is pinnable only when
   * its plugin is installed and enabled, the version is `ready`, at most one
   * version per plugin is pinned, and none of its skills carry supporting
   * files. Not a general-purpose plugin list.
   */
  pluginVersionIds?: string[];
  /**
   * Sandbox-image pin: a `PlatformImage` id this environment's reproducibility
   * runs boot a fresh sandbox from. Must be a project-shared image (personal
   * drafts are rejected — promote first). Applies to eval runs today.
   */
  sandboxImageId?: string;
  /** Pass back as `expectedRevision` on the next mutation. */
  revision: number;
  /** Archived environments cannot be edited or launched until restored. */
  archived: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * An UNNAMED, content-addressed environment: a composed client/model/computer/
 * skills stack, not a saved entry in the project's environment list.
 *
 * Its own type rather than `PlatformEnvironment` with a nullable name, because
 * `PlatformEnvironment.name` is a required string and every listing filters
 * ad-hoc rows out precisely so that promise holds. Widening it would break
 * readers who trusted it, for a row they never asked to see.
 */
export interface PlatformAdhocEnvironment {
  id: string;
  projectId: string;
  /** Always `null` — an ad-hoc environment is unnamed by construction. */
  name: null;
  /** Always `true`. Present so a reader never has to infer it from the null. */
  adhoc: true;
  description?: string;
  hostId: string;
  serverAttachmentId?: string;
  /** See `PlatformEnvironment.modelId` — absent means "inherit the host's". */
  modelId?: string;
  skillSelection?: PlatformEnvironmentSkillSelection;
  secretSelection?: PlatformEnvironmentSecretSelection;
  pluginVersionIds?: string[];
  sandboxImageId?: string;
  /** Pass back as `expectedRevision` when promoting it with a name. */
  revision: number;
  archived: boolean;
  archivedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * The result of ensuring a composed stack exists.
 *
 * `created` distinguishes "this call minted the row" from "the same stack was
 * already ensured", which is the only way a caller can tell a first compose
 * from a repeat — the status line cannot, because get-or-create answers 200
 * either way.
 */
export interface PlatformAdhocEnvironmentEnsured {
  environment: PlatformAdhocEnvironment;
  created: boolean;
}

/**
 * The composed stack itself: the same execution axes a named environment
 * carries, minus the name. Content-addressed server-side, so the same stack
 * always resolves to the same environment.
 */
export interface PlatformAdhocEnvironmentBody {
  hostId: string;
  serverAttachmentId?: string;
  modelId?: string;
  skillSelection?: PlatformEnvironmentSkillSelection;
  secretSelection?: PlatformEnvironmentSecretSelection;
  pluginVersionIds?: string[];
  sandboxImageId?: string;
}

/**
 * The outcome of appending one environment to a suite's attachments.
 *
 * `attached: false` means it was ALREADY there — a no-op, not a failure, which
 * is what lets a retried compose-and-run converge.
 */
export interface PlatformEvalSuiteEnvironmentAttached {
  suiteId: string;
  attached: boolean;
  /** The suite's attachments after the call, in attach order. */
  environmentIds: string[];
}

/** Promote an ad-hoc environment to a named one, in place. */
export interface PlatformEnvironmentNameBody {
  /** The revision you last read. Stale ⇒ 409 CONFLICT. */
  expectedRevision: number;
  name: string;
  description?: string;
}

export interface PlatformEnvironmentCreateBody {
  name: string;
  description?: string;
  hostId: string;
  serverAttachmentId?: string;
  /** Model to run instead of the host's; omit to inherit the host's. */
  modelId?: string;
  skillSelection?: PlatformEnvironmentSkillSelection;
  secretSelection?: PlatformEnvironmentSecretSelection;
  pluginVersionIds?: string[];
  /** Project-shared `PlatformImage` id to pin; omit for the default image. */
  sandboxImageId?: string;
}

/**
 * Update body. Three-state on the clearable fields: omit to leave unchanged,
 * pass `null` to CLEAR, pass a value to set. An empty array is rejected — it is
 * not a way to clear.
 */
export interface PlatformEnvironmentUpdateBody {
  /** Required: the revision you last read. Stale ⇒ 409 CONFLICT. */
  expectedRevision: number;
  name?: string;
  /** An empty string clears the description. */
  description?: string;
  hostId?: string;
  serverAttachmentId?: string | null;
  /**
   * New model override, or `null` to CLEAR it and fall back to the host's
   * model. Omit to leave unchanged. An empty string is rejected — it is not a
   * way to clear.
   */
  modelId?: string | null;
  skillSelection?: PlatformEnvironmentSkillSelection | null;
  /**
   * New credential grant, or `null` to REVOKE it entirely. Omit to leave
   * unchanged. `[]` is rejected: an accidental empty array that read as "remove
   * every credential" would break a workflow with no error to look at.
   */
  secretSelection?: PlatformEnvironmentSecretSelection | null;
  pluginVersionIds?: string[] | null;
  /** New sandbox-image pin, or null to clear it. Omit to leave unchanged. */
  sandboxImageId?: string | null;
}

/**
 * What this deployment's environment surface supports.
 *
 * FOR VERSION SKEW, not feature flagging. The SDK ships independently of the
 * backend, so a client that would send `modelId` must first confirm the
 * deployment accepts it — an unknown field is a hard validator error there, not
 * a silently ignored one. A deployment too old to answer reports `false` for
 * everything.
 */
export interface PlatformEnvironmentCapabilities {
  /** `modelId` is accepted on create and update. */
  modelOverrides: boolean;
  /** Environment cells may vary by model on one host (the compare grid). */
  modelMatrix: boolean;
  /**
   * `startTestSuiteRun` accepts `ephemeralEnvironment` — a project-scoped
   * env may launch without suite membership. Absent/false on older backends.
   */
  ephemeralEnvironmentLaunch?: boolean;
}

/** Body for the archive/restore sub-actions — the precondition only. */
export interface PlatformEnvironmentRevisionBody {
  expectedRevision: number;
}

/**
 * What an environment resolves to right now: the host's current config, the
 * closed server set, and the pinned plugin versions. The same resolution an
 * eval run performs, exposed so an external runner can connect the exact set
 * before launching.
 */
export interface PlatformEnvironmentResolved {
  environment: { id: string; name: string; revision: number };
  hostId: string;
  hostName: string;
  /** The host's config at resolve time — hosts rotate configs live. */
  hostConfigId: string;
  /** The environment's stored override, when it sets one. */
  modelId?: string;
  /**
   * The model this environment WILL RUN — the override if it has one, else the
   * host config's. Always present on a successful resolve: an environment with
   * no model anywhere cannot be resolved for launch at all, and fails with a
   * 409 carrying `details.reason: "environment_model_required"`.
   *
   * Optional in the type only for deploy skew, where the backend predates the
   * field.
   */
  effectiveModelId?: string;
  /** Which of the two supplied {@link effectiveModelId}. */
  modelSource?: "environment" | "host";
  serverAttachmentId?: string;
  /** The closed NON-plugin server set. */
  selectedServerIds: string[];
  /**
   * `selectedServerIds` plus the servers contributed by pinned plugin
   * versions — the set a run actually connects. Identical to
   * `selectedServerIds` when the environment pins no plugins.
   */
  effectiveServerIds: string[];
  pluginVersions: Array<{
    pluginId: string;
    pluginVersionId: string;
    name: string;
    bundleHash: string;
  }>;
  /** Connectable projection of `effectiveServerIds`, healed to live servers. */
  servers: Array<{ serverId: string; name: string }>;
  /** The environment's sandbox-image pin, when set (and the backend is new
   *  enough to carry it through the resolve). */
  sandboxImageId?: string;
}

// ── Cloud Skills ─────────────────────────────────────────────────────────────
//
// An authored SKILL.md stored in Convex. Environments pin them by id
// (`skillSelection.skillIds`) and eval runs pin them with `--compose-skill`,
// so the id is the load-bearing value — and this READ-ONLY surface is the only
// programmatic way to obtain one. Authoring stays on the app's `/api/web`
// surface behind the `skills-enabled` beta gate.

/**
 * Which PROJECT SECRETS a run launched from this environment receives.
 *
 * Ids only. The environment is the GRANT BOUNDARY: no selection means no
 * secrets, and there is no "all of them" mode — a credential is granted
 * deliberately, per environment.
 *
 * Deliberately simpler than `PlatformEnvironmentSkillSelection`: no version
 * pins, because a secret has exactly one current value and "pin the previous
 * value" is the opposite of what rotation is for.
 *
 * Membership is not the same as delivery. A `sharing: "user"` secret selected
 * here reaches ONLY sessions its owner started; every other member's run of
 * this environment silently does not receive it. That rule is checked live at
 * launch, so revoking someone's access does not require editing every
 * environment that names their secret.
 */
export interface PlatformEnvironmentSecretSelection {
  mode: "explicit";
  secretIds: string[];
}

/** Why a skill cannot be pinned into an environment's `skillSelection`. */
export type PlatformSkillPinnability =
  | { ok: true }
  | { ok: false; reason: string };

/** One skill visible to the caller: project-shared, or their own draft. */
export interface PlatformProjectSkill {
  id: string;
  projectId: string;
  /** Load-bearing identity: the on-box dir name and `loadSkill(name)` arg. */
  name: string;
  description: string;
  /** `project` = shared with the org (the only kind an environment may pin). */
  sharing: "user" | "project";
  isOwner: boolean;
  /** Drift key folding in the body and any supporting files. */
  aggregateHash: string;
  provenance?: string;
  /**
   * Whether this skill may be pinned. Absent on older backends — treat absent
   * as UNKNOWN, never as `{ok:true}`: a skill with supporting files or extra
   * frontmatter is rejected at save time, and guessing would just move the
   * failure later.
   */
  pinnability?: PlatformSkillPinnability;
  createdAt: number;
  updatedAt: number;
}

/** One skill with its SKILL.md body (frontmatter stripped). */
export interface PlatformProjectSkillDetail extends PlatformProjectSkill {
  content: string;
}

// ── Agent Plugins ────────────────────────────────────────────────────────────
//
// A plugin bundle (agent-plugins.org format) imported into a project. Each
// immutable VERSION materializes MCP servers and skills as ordinary project
// rows; environments pin `pluginVersionIds` to run them. This surface is
// READ-ONLY — import, activate, enable/disable and uninstall stay in the app.

/** One live (installed, non-uninstalled) plugin in a project. */
export interface PlatformPlugin {
  id: string;
  projectId: string;
  /** Normalized plugin name — the namespace its skills load under. */
  name: string;
  displayName?: string;
  description?: string;
  /** Disabled plugins keep their versions but resolve for no run. */
  enabled: boolean;
  /** The version environment pins default to; absent before first activate. */
  activeVersionId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Per-component tallies of one imported version. `apps` counts preserved
 *  `.app.json` metadata entries only (no runtime effect). */
export interface PlatformPluginComponentCounts {
  skills: number;
  servers: number;
  apps: number;
  assets: number;
  unsupported: number;
}

/** One MCP server a plugin version declares, with its materialized row. */
export interface PlatformPluginServerComponent {
  componentId: string;
  /** Stable key within the version (normalized server map key). */
  componentKey: string;
  declaredName: string;
  /** Where the component can execute; `local`/`computer` never run hosted. */
  placement: "remote" | "local" | "computer";
  /** Declared auth timing: setup right after import, or on first use. */
  authenticationPolicy: "on_install" | "on_use";
  /** The project server row this component materialized as. */
  materializedServerId: string;
}

/** One skill a plugin version declares, with its materialized row. */
export interface PlatformPluginSkillComponent {
  componentId: string;
  componentKey: string;
  declaredName: string;
  /** Namespaced model-facing reference: `<plugin-name>/<skill-name>`. */
  modelRef: string;
  materializedSkillId: string;
}

/** One immutable imported version with its component projections. */
export interface PlatformPluginVersion {
  id: string;
  pluginId: string;
  /** `manifest.version` — metadata only; `bundleHash` is the identity. */
  declaredVersion?: string;
  bundleHash: string;
  manifestHash?: string;
  /** Only `ready` versions resolve at runtime or serve bundle bytes. */
  status: "staging" | "ready" | "invalid";
  componentCounts: PlatformPluginComponentCounts;
  servers: PlatformPluginServerComponent[];
  skills: PlatformPluginSkillComponent[];
  createdAt: number;
  readyAt?: number;
}

// ── Sandbox images ───────────────────────────────────────────────────────────
//
// A project's custom Computer base image: a blueprint plus its builds. Named
// "image" (the OCI term) and NOT "environment" — a Project Environment is an
// unrelated concept (a client + server group + skill/plugin bundle that suites
// and journeys run against), and it owns that word.

export interface PlatformImageBuild {
  id: string;
  status: "queued" | "building" | "ready" | "failed";
  provider: "e2b" | "stub";
  e2bBuildId?: string;
  baseImageDigests: string[];
  logPreview?: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

/** A project's custom Computer sandbox image (its blueprint + latest build).
 * The list and detail routes return the same shape. */
export interface PlatformImage {
  id: string;
  projectId: string;
  name: string;
  blueprint: string;
  contentHash: string;
  sharing: "user" | "project";
  isOwner: boolean;
  currentBuild: PlatformImageBuild | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformImageDeleted {
  id: string;
  deleted: true;
}

/** Result of linting blueprint YAML via `POST …/images/validate`. Always
 * HTTP 200 — `ok: false` is a successful lint with structured errors. */
export type PlatformImageBlueprintValidation =
  | { ok: true; baseImageDigest: string }
  | { ok: false; errors: { path: string; message: string }[] };

/** `POST …/build` is async (202): the build runs in the background — poll the
 * builds list for status. */
export interface PlatformImageBuildStarted {
  id: string;
  buildId: string;
  reused: boolean;
}

export interface PlatformComputerAttached {
  imageId: string;
  computerId: string;
  status: string;
}

export interface PlatformComputerReset {
  projectId: string;
  reset: boolean;
}

/** `200` response of `POST /eval-suites/{id}/cases/generate`. */
export interface PlatformEvalCasesGenerated {
  /** The backend LLM that authored the cases — NOT the case execution model. */
  generationModel: string;
  created: PlatformEvalCase[];
  counts: { normal?: number; negative?: number };
  /** Drafts that were generated but failed to persist (never silently dropped). */
  skipped?: Array<{ title: string; error: string }>;
}

export interface PlatformEvalIteration {
  id: string;
  /**
   * The STORED case row's database id. Distinct from `caseId` below and never
   * interchangeable with it: this one exists for every case the platform
   * persisted, changes if the case is recreated, and means nothing outside this
   * deployment.
   */
  testCaseId: string | null;
  /**
   * The case's SDK-DECLARED id, when the run recorded one.
   *
   * Read from the iteration's frozen `testCaseSnapshot`, so it is the id the
   * suite declared AT RUN TIME — the durable, author-chosen identity that
   * survives a case being recreated. ABSENT on a UI-authored case (which never
   * declared one) and on runs predating declared ids; absence is not an error.
   *
   * NOT a join key into `verdictSummary.cases[].caseId`, which is a separately
   * ENCODED identity the platform mints from whichever spelling a given run
   * knew. Matching one against the other attaches a trial to the wrong case
   * aggregate.
   */
  caseId?: string;
  title: string | null;
  iterationNumber: number;
  /**
   * LIFECYCLE, not verdict: `pending`, `running`, `completed`, `failed`,
   * `cancelled`, `timed_out`, `setup_failed`, `skipped`.
   *
   * A normally-executed trial that graded badly is `completed` with
   * `result: "failed"` — reading `status === "failed"` as "the case failed"
   * counts harness noise as server defects. `setup_failed` (environment never
   * came up) and `skipped` (deliberately not run) are the two states an older
   * deployment cannot emit.
   */
  status: string;
  /** Task verdict once terminal: `"passed" | "failed" | null`. */
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
  /**
   * Per-scorer verdicts for this iteration, in the evaluation contract's
   * shape. `null` when the run predates scoring, or when the stored payload
   * failed validation at the boundary — a public caller never receives
   * partially-trusted score data.
   */
  scores?: ScoreResult[] | null;
  /**
   * The definitions those scores were produced under, plus their hash.
   *
   * Ships with `scores` or not at all: `role` and the error policies live here,
   * so results without it cannot be told apart as gating or advisory.
   */
  evaluationConfig?: EvaluationConfigSnapshot | null;
  /** Set when the backend downgraded this iteration's verdict at ingest. */
  scoreIntegrity?: "score_integrity_invalid" | null;
  /** Verified D1 user-value chain rows, in chain order. */
  stageResults?: StageResultRow[];
  /** The first failed stage, when the verified derivation has one. */
  firstFailedStage?: UserValueStage;
  /** Coarse failure bucket; it may exist without a failed stage row. */
  failureCategory?: FailureCategory;
  /** Analyzer version that produced the stage rows. */
  stageAnalyzerVersion?: number;
  /** The server returned stage rows that failed D1 validation. */
  stageResultsUnverified?: true;
}

/** Public-safe evidence for one eval step (resolved URLs, no blob ids). */
export interface PlatformEvalStepEvidence {
  /** Widget→host tool calls the interaction triggered. */
  toolCalls?: Array<{
    name: string;
    args: unknown;
    ok: boolean;
    error?: string;
    /** Wall-clock ms for this widget→host call, when the harness recorded it. */
    elapsedMs?: number;
  }>;
  /** Resolved screenshot URL for the step's render/interaction. */
  screenshotUrl?: string;
  /** Resolved iteration replay `.webm` URL (same on every step of the run). */
  videoUrl?: string;
  /** Playback offset of this step within the replay video, when known. */
  videoOffsetMs?: number;
  /** "scripted" (authored) vs "computer_use" (model-driven) interaction. */
  source?: "computer_use" | "scripted";
  /** Human-readable interaction target (e.g. the button label). */
  locatorLabel?: string;
}

/**
 * One row per authored test step, in author order — the public mirror of the
 * fail-fast step engine. `status` is the per-step verdict; `evidence` is present
 * only when the step produced a screenshot / video / widget tool call.
 */
export interface PlatformEvalStepResult {
  stepId: string;
  stepIndex: number;
  kind: "prompt" | "toolCall" | "interact" | "assert";
  status: "ok" | "fail" | "skipped" | "pending";
  reason: string | null;
  evidence?: PlatformEvalStepEvidence;
}

/**
 * Share link for a scenario. The URL embeds the access token; it is visible
 * to any caller who can read the scenario (same audience as the hosted UI).
 */
export interface PlatformScenarioLink {
  /** App-relative share path. */
  path: string;
  /** Absolute share URL. */
  url: string;
}

/** A server attached to a scenario (HTTP servers only). */
export interface PlatformScenarioServer {
  id: string;
  name: string;
  url: string | null;
  useOAuth: boolean;
}

/** Summary of a published scenario, as returned by the list endpoint. */
export interface PlatformScenarioSummary {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  /** Who can use it: "project_members" | "invited_only" | "anyone_with_link". */
  mode: string | null;
  /** Chat surface style the scenario renders (e.g. "claude", "chatgpt"). */
  hostStyle: string | null;
  hostId: string | null;
  hostName: string | null;
  serverCount: number;
  serverNames: string[];
  link: PlatformScenarioLink | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** A scenario's full read-only settings: summary plus host execution config. */
export interface PlatformScenarioDetail extends PlatformScenarioSummary {
  /** Model the scenario chats with. */
  modelId: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  requireToolApproval: boolean;
  servers: PlatformScenarioServer[];
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
 * persisted on the server record so evals/scenarios can target it); treat
 * the whole grant as a credential. Re-creating rotates the secret and
 * revokes the previous grant.
 */
export interface PlatformTunnelGrant {
  serverId: string;
  name: string;
  /** True when a server record with this name already existed. */
  existed: boolean;
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

// ── Journeys (the API surface for the Swarms product) ────────────────────────
//
// "Swarm" is deliberately not a resource noun. A swarm is a container users
// author in the UI; what EXECUTES is a journey (a persona pursuing a goal
// against one or more environments) and what it produces is a journey run.
//
// FLAG-GATED BETA (`sandboxes-enabled`). Reads are open — an empty list leaks
// nothing — but launching, cancelling and authoring are enforced server-side
// per organization, so an unflagged caller gets a structured
// FEATURE_UNAVAILABLE error from those.

export interface PlatformJourney {
  id: string;
  projectId: string;
  name: string;
  /** What the persona is trying to accomplish. Drives the whole run. */
  goal: string;
  personaId: string;
  /** The swarm container this journey was authored under, if any. Opaque. */
  swarmId: string | null;
  /** Environments this journey fans out across. Empty on a host-pinned journey. */
  environmentIds: string[];
  serverAttachmentId?: string;
  /** Sessions run against EACH target. Total sessions = targets x this. */
  sessionsPerTarget: number | null;
  maxTurns: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformJourneyRunTarget {
  hostId: string;
  hostName?: string;
  /** Execution identity. Two targets can share a `hostId`. */
  targetId?: string;
  modelId?: string;
}

export interface PlatformJourneyRunAttempt {
  chatSessionId: string | null;
  hostId: string;
  targetId: string | null;
  sessionIndex: number;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PlatformJourneyRun {
  id: string;
  projectId: string;
  journeyId: string;
  /**
   * The batch this run was launched with. Sibling runs of one co-launched
   * wave share it; a solo relaunch is a wave of one.
   */
  waveId?: string;
  status: "running" | "completed" | "partial" | "failed" | "rate_limited";
  /**
   * True when someone STOPPED this run. It reports `status: "failed"` because
   * the backend records cancellation as a marker rather than a status literal
   * — so check this before showing a run as a failure.
   */
  canceled: boolean;
  /** True when the runner went silent and the watchdog settled the run. */
  stale: boolean;
  /** Raw marker behind `canceled` / `stale`, when present. */
  error?: string;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  };
  targets: PlatformJourneyRunTarget[];
  persona?: {
    personaId: string | null;
    name: string | null;
    role: string | null;
  };
  /** Per-session execution records. Present on the single-run read. */
  attempts?: PlatformJourneyRunAttempt[];
  targetSummaries?: Array<{
    hostId: string;
    targetId?: string;
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  }>;
  createdAt: number;
  lastHeartbeatAt?: number;
  /** Common insights envelope (detail response only; lists stay compact).
   * Absent on servers deployed before the envelope existed. */
  insights?: PlatformInsightsEnvelope;
}

export interface PlatformJourneyRunSession {
  /**
   * The session's document id — the same value `listChatSessions` returns as
   * `id`, so a session found here can be looked up there.
   */
  id: string;
  /**
   * The RUNTIME key for the same session, which the chat transport and the
   * app's deep links use. Distinct from `id` and not interchangeable with it.
   */
  chatSessionId: string;
  projectId: string;
  hostId?: string;
  runId?: string;
  journeyId?: string;
  personaId?: string;
  personaLabel?: string;
  /**
   * ARCHIVAL state (`active` | `archived`) — a run session stays `active`
   * forever unless archived, so this says nothing about how it went. Read
   * `outcome` for the verdict.
   */
  status: string | null;
  /**
   * How this session's run attempt ended: `succeeded` | `failed` |
   * `rate_limited` | `running` | `pending`, or null when the attempt cannot
   * be matched (historical runs). Absent on servers that predate the field.
   */
  outcome?: string | null;
  readiness: unknown;
  goalScore: unknown;
  messageCount: number;
  preview?: string;
  modelId?: string;
  startedAt: number | null;
  lastActivityAt: number | null;
}

// ── Scenarios (the API surface for user testing) ─────────────────────────────
//
// A scenario is a project environment published for people outside the project
// to talk to. It is a `scenarios` row all the way down: this used to be a
// transport-DTO rename over a `chatboxes` table, and that split is gone —
// storage, routes and operations all say scenario now.
//
// `PlatformScenario` here is the PUBLISH response. The list/read shapes are
// `PlatformScenarioSummary` and `PlatformScenarioDetail` above; they were
// named for the old table, and kept the `Summary` suffix rather than colliding
// with this one.

export interface PlatformScenario {
  id: string;
  environmentId: string;
  name: string;
  /**
   * Who may open the share link. `anyone_with_link` is the widest — anyone
   * holding the URL, signed in or not.
   */
  mode: "project_members" | "invited_only" | "anyone_with_link";
  /**
   * Bumped whenever access NARROWS (mode change, member removal, link
   * rotation). Sessions minted under an older version stop working, which is
   * what makes those changes take effect at once rather than at expiry.
   */
  accessVersion: number;
  /** The share link. Null when the scenario has no link token. */
  link: string | null;
  /** False when the environment was already published and this returned it. */
  created?: boolean;
  /**
   * True when `publishScenario`'s create-time overrides (`name`,
   * `description`, `mode`) were NOT applied because the environment was
   * already published. Paired with `created: false`.
   *
   * Declared here rather than as an intersection at the two call sites that
   * return it. Both did — `Promise<PlatformScenario & { overridesIgnored?:
   * boolean }>` — which typed the field for a caller who read it off the
   * return value and left it invisible to anything holding a
   * `PlatformScenario`, including the spec↔types parity check. A field the
   * wire really carries belongs on the interface that describes the wire.
   */
  overridesIgnored?: boolean;
}

export interface PlatformScenarioDeleted {
  environmentId: string;
  /** False when the environment had no scenario — not an error. */
  deleted: boolean;
  id?: string;
}

/** Result of `POST /projects/{p}/journeys/{journeyId}/runs`. */
export interface PlatformJourneyRunLaunched {
  /** The run id. Poll `getJourneyRun` with it, or stop it with `cancel`. */
  id: string;
  journeyId: string;
  projectId: string;
  /**
   * Always `"running"` — the run row exists and its fan-out has been started.
   * The response is a 202: nothing here says the journey has finished, only
   * that it is under way.
   */
  status: string;
  /**
   * True when an idempotency key replayed onto a run that ALREADY existed, so
   * nothing new was started. A retry of a dropped response lands here, which
   * is how you tell "I launched it" from "it was already going".
   */
  deduped: boolean;
}

/** Result of `POST /projects/{p}/journey-runs/{runId}/cancel`. */
export interface PlatformJourneyRunCanceled {
  id: string;
  /** The run's terminal status after the cancel settled it. */
  status: PlatformJourneyRun["status"];
  canceled: true;
  /** True when the run was ALREADY canceled and this call did nothing. */
  alreadyCanceled: boolean;
  /** Attempts this call moved to terminal. Zero on an idempotent replay. */
  finalized: number;
}

// ── Swarms authoring + insights ─────────────────────────────────────────────

/** A reusable synthetic character. The GOAL lives on the journey, not here. */
export interface PlatformPersona {
  /** Durable id — what journeys reference and every route here addresses. */
  id: string;
  projectId: string;
  /**
   * Stable slug key, shared with exported session data. Useful for correlating
   * transcripts; NOT an address for this API.
   */
  slug: string;
  name: string;
  role: string;
  notes: string | null;
  /** manual | generated | cluster — how the persona came to exist. */
  source: string;
  seedKeywords?: string[];
  avatar: { shape: number | null; palette: number | null };
  createdAt: number;
  updatedAt: number;
}

/**
 * A PROJECT SECRET — metadata only, always.
 *
 * There is no `value` field on this type, and there is no route, operation, or
 * tool that returns one. A secret is written and delivered; it is never read
 * back. That is the contract, not a default: the only code that decrypts writes
 * into a sandbox's environment or an egress policy and returns nothing.
 */
export interface PlatformSecret {
  id: string;
  projectId: string;
  /**
   * The environment-variable name (`^[A-Z_][A-Z0-9_]*$`). This IS the secret's
   * identity: it is what a materialized delivery exports, what a workflow
   * references, and what stays stable across a rotation. Immutable — renaming
   * is delete-and-recreate.
   */
  name: string;
  description: string | null;
  /**
   * How the value reaches a run.
   *
   *  - `"brokered"` — injected as a request header by the sandbox's egress
   *    proxy, OUTSIDE the VM. The box never holds it, so a prompt-injected
   *    agent has nothing to exfiltrate. Prevents EXTRACTION, not USE: any
   *    process in the box can call the bound host while the policy is live.
   *    HTTPS APIs only (the proxy binds domain rules on ports 80/443).
   *  - `"materialized"` — a real environment variable inside the box, because a
   *    CLI cannot read a header the proxy adds. EXTRACTABLE BY DESIGN: `env`
   *    prints it.
   */
  delivery: "brokered" | "materialized";
  /** Brokered only: the exact hostnames the header is injected on. */
  brokerHosts?: string[];
  /** Brokered only: the header name, e.g. `Authorization`. */
  brokerHeader?: string;
  /** Brokered only: the header value template; `{}` is where the value goes. */
  brokerTemplate?: string;
  /**
   * `"project"` — admin-managed, delivered to every member's sessions.
   * `"user"` — personal; delivered ONLY in sessions its owner starts, and
   * silently absent from another member's run of the same environment.
   * Immutable — re-sharing is delete-and-recreate.
   */
  sharing: "user" | "project";
  /** Personal secrets only. Project-shared rows have no owner. */
  ownerUserId?: string;
  /**
   * When this secret was last HANDED TO a run — not when it was last used.
   * Brokered use is unobservable by construction (the proxy injects the header;
   * we never see the request), so "used" would be a number nobody can honestly
   * produce. `null` means nothing has been recorded, which is not the same as
   * "never delivered".
   */
  lastDeliveredAt: number | null;
  createdAt: number;
  updatedAt: number;
  createdByUserId: string;
  updatedByUserId: string;
}

/**
 * Result of deleting a secret. A HARD delete — the row and the ciphertext both
 * go. This is the revoke button, so it must not be soft.
 */
export interface PlatformSecretDeleted {
  id: string;
  projectId: string;
  /** Echoed so a caller logging the revoke does not need a prior read. */
  name: string;
  deleted: true;
}

/** Result of deleting a persona. The delete is SOFT: history still resolves it. */
export interface PlatformPersonaDeleted {
  id: string;
  projectId: string;
  deleted: true;
}

/** Result of archiving a journey. Its runs and transcripts stay readable. */
export interface PlatformJourneyArchived {
  id: string;
  projectId: string;
  archived: true;
}

/** A swarm CONTAINER: shared execution config for the journeys authored in it. */
export interface PlatformSwarm {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  /** Default fan-out for journeys authored under this container. */
  environmentIds: string[];
  sessionsPerTarget: number | null;
  maxTurns: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformSwarmArchived {
  id: string;
  projectId: string;
  archived: true;
}

/** One rubric criterion's tally over a run. The four counts are NOT mergeable. */
export interface PlatformScorecardCriterion {
  id: string;
  label: string | null;
  kind: string;
  passCount: number;
  failCount: number;
  /** Claimed for grading and unfinished — includes crashed runners. */
  pendingCount: number;
  /**
   * Sessions whose GRADING broke. Distinct from `failCount` on purpose:
   * folding them together makes a crashed judge look like a regression.
   */
  failedGradingCount: number;
}

/** Deterministic rubric result for one run. No model involved. */
export interface PlatformRunScorecard {
  runId: string;
  /**
   * Every criterion the run's rubric declared, in snapshot order — including
   * ones nothing was graded against. An absent row would be indistinguishable
   * from a criterion that was never configured.
   */
  criteria: PlatformScorecardCriterion[];
  sessionsTotal: number;
  sessionsGraded: number;
}

export interface PlatformSwarmOverviewFinding {
  criterionId: string;
  label: string | null;
  kind: string | null;
  failCount: number;
  pendingCount: number;
  failedGradingCount: number;
  /**
   * The DENOMINATOR for any rate you compute. Never divide by the session
   * total — 3 failures of 4 graded sessions out of 40 attempted is not 7.5%.
   */
  sessionsGraded: number;
  /** Consecutive runs of this journey where the criterion failed. */
  runStreak: number;
}

export interface PlatformSwarmOverviewRun {
  runId: string;
  journeyId: string;
  journeyName: string;
  journeyArchived: boolean;
  personaName: string;
  status: string;
  waveId?: string;
  summary: {
    total: number;
    succeeded: number;
    failed: number;
    rateLimited: number;
  };
  goalCompletion: {
    gradedCount: number;
    passedCount: number;
    avgScore: number | null;
    pendingCount: number | null;
    failedCount: number | null;
  } | null;
  findings: PlatformSwarmOverviewFinding[];
  targets: Array<{
    hostName: string;
    modelId: string;
    environmentName?: string;
  }>;
  createdAt: number;
}

/** Project-wide roll-up across recent runs. */
export interface PlatformSwarmOverview {
  runs: PlatformSwarmOverviewRun[];
  runsConsidered: number;
  goalCompletion: {
    gradedCount: number;
    passedCount: number;
    /** `null` when nothing is graded yet — never 0, which would read as "all failed". */
    passRate: number | null;
    runsWithGrades: number;
    trend: Array<{
      dayStartMs: number;
      gradedCount: number;
      passedCount: number;
      passRate: number;
    }>;
  };
}

/** A criterion that keeps failing, tracked across waves. */
export interface PlatformSwarmFinding {
  id: string;
  /** Stable identity across waves — what makes a streak a streak. */
  fingerprint: string;
  dimension: string;
  subject: { kind: string; id: string; label: string };
  /** new | recurring | regressed | resolved. */
  status: string;
  occurrenceCount: number;
  lastSeenWaveId: string;
  firstSeenAt: number;
  lastSeenAt: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
  updatedAt: number;
}

export interface PlatformFindingDismissed {
  id: string;
  projectId: string;
  dismissed: boolean;
}

/**
 * The common actionable-insights envelope — one shape across Eval runs,
 * Swarm waves, and User Testing windows. Hand-mirrored from the backend's
 * `lib/insightsEnvelope.ts` (two-repo type discipline).
 *
 * Reading rules for consumers (including agents):
 * - Findings are AGGREGATED per run/wave/window; `evidence` points at
 *   exemplar sessions or iterations, not one finding per session.
 * - Only `actionTarget: "mcp_server"` with `actionability: "ready"`
 *   authorizes proposing a change to the MCP server. Every other action
 *   target names different work (agent config, eval case, environment,
 *   investigation) and must NOT be "fixed" in server code.
 * - `findings` is empty unless `status === "completed"`. An empty completed
 *   list is a real "nothing to act on" answer.
 * - Reads never trigger generation; `status` is observational.
 */
export type PlatformInsightsStatus =
  | "not_available"
  | "not_requested"
  | "pending"
  | "completed"
  | "failed";

export type PlatformInsightScope =
  | { kind: "eval_run"; id: string }
  | { kind: "swarm_wave"; id: string; runId: string }
  | {
      kind: "user_testing_window";
      id: string;
      scenarioId: string;
      windowStartAt: number;
      windowEndAt: number;
    };

export type PlatformInsightAttribution =
  | "unknown"
  | "server_contract"
  | "server_runtime"
  | "server_capability"
  | "agent_or_prompt"
  | "test_design"
  | "environment";

export type PlatformInsightActionTarget =
  | "investigate"
  | "mcp_server"
  | "agent_configuration"
  | "eval_case"
  | "environment";

export type PlatformInsightActionability =
  | "informational"
  | "investigate"
  | "ready";

export interface PlatformActionableFindingEvidence {
  sessionId?: string;
  iterationId?: string;
  kind: "tool_error" | "transcript" | "feedback" | "judge" | "contrast";
  /** Scrubbed and clipped at the producer. */
  excerpt: string;
  toolName?: string;
  errorCode?: string;
}

export interface PlatformActionableFinding {
  /** Stable remediation id (`rf_<16 hex>`) — survives dynamic error values. */
  id: string;
  /** The registry signal this derives from; several findings may share one. */
  signalFingerprint: string;
  title: string;
  category:
    | "unknown"
    | "tool_contract"
    | "tool_runtime"
    | "capability_gap"
    | "workflow"
    | "agent_behavior"
    | "test_design"
    | "environment";
  attribution: PlatformInsightAttribution;
  actionTarget: PlatformInsightActionTarget;
  actionability: PlatformInsightActionability;
  severity: "info" | "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  /** Deterministic observation — counts and identities, never model prose. */
  observed: string;
  rootCause?: string;
  recommendation: string;
  acceptanceCriteria: string[];
  affected: {
    count: number;
    total: number;
    unit: "iterations" | "sessions";
  };
  patternSlug?: string;
  /** Present only when a server (and, for tool surfaces, tool) resolved
   * against the pinned snapshot. Required for `mcp_server`/`ready`. */
  target?: {
    serverId: string;
    toolName?: string;
    surface:
      | "description"
      | "input_schema"
      | "output_schema"
      | "handler"
      | "server_instructions"
      | "capability";
    fieldPath?: string;
    snapshotHash: string;
    currentDefinition?: {
      description?: string;
      inputSchemaJson?: string;
      outputSchemaJson?: string;
      truncated: boolean;
    };
  };
  evidence: PlatformActionableFindingEvidence[];
}

export interface PlatformInsightsEnvelope {
  schemaVersion: 1;
  scope: PlatformInsightScope;
  status: PlatformInsightsStatus;
  reasonCode: string | null;
  retryable: boolean;
  error: { code: string; message: string } | null;
  generatedAt: number | null;
  updatedAt: number | null;
  summary: string | null;
  coverage: {
    unit: "iterations" | "sessions";
    analyzed: number;
    total: number;
    gradedCount?: number;
    feedbackCount?: number;
    truncated: boolean;
    lowConfidence: boolean;
  };
  findings: PlatformActionableFinding[];
  /** Swarm only. Launch outcomes never appear as findings. */
  runHealth?: {
    targets: Array<{
      subjectKind: "environment" | "host";
      subjectId: string;
      subjectLabel: string;
      attempted: number;
      succeeded: number;
      failed: number;
      rateLimited: number;
    }>;
  };
  truncation: {
    truncated: boolean;
    omittedFindings: number;
    omittedEvidence: number;
    contractTruncated: boolean;
  };
}

/**
 * A repository whose pull requests run an eval suite.
 *
 * `outagePolicy: null` is a REAL state, not a missing value: it means nobody
 * chose a policy for this repository (it was connected before the choice
 * existed). The effective behaviour is `fail_open`, but reporting `fail_open`
 * would say someone picked it.
 */
export interface PlatformEvalCheckRepo {
  id: string;
  /** `owner/repo`, canonicalized by the platform. */
  repo: string;
  enabled: boolean;
  /** The eval suite this repository's pull requests run. */
  suiteId: string | null;
  projectId: string | null;
  outagePolicy: "fail_open" | "fail_closed" | null;
  createdAt: number | null;
  updatedAt: number | null;
}

/** What `GET /organizations/{id}/eval-check-repos` answers. */
export interface PlatformEvalCheckRepos {
  organizationId: string;
  /**
   * Whether GitHub Checks is available for this organization at all. FALSE and
   * "available, nothing connected" are different situations, and only one of
   * them is fixed by connecting a repository — so it travels rather than being
   * flattened into an empty list.
   */
  available: boolean;
  /** The repositories already connected. */
  items: PlatformEvalCheckRepo[];
  /**
   * The repositories the MCPJam GitHub App can reach — the choices a connect
   * has.
   *
   * `null` means the question could not be ASKED: the lookup itself failed
   * (GitHub unreachable, or the call errored). The already-connected `items`
   * above still stand — they need no GitHub call.
   *
   * `[]` means it WAS asked and came back with nothing. That covers two
   * situations the platform does not distinguish: the App is installed but
   * reaches no repository, and this deployment has no App installation at all.
   * If a connect is failing and this is empty, check the installation before
   * assuming a permissions problem.
   */
  connectable: Array<{ repo: string }> | null;
}

/** `201` response of `POST /organizations/{id}/eval-check-repos`. */
export interface PlatformEvalCheckRepoConnected {
  id: string;
  organizationId: string;
  projectId: string;
  suiteId: string;
  repo: string;
  outagePolicy: "fail_open" | "fail_closed";
}

/** Receipt for an eval-run insights (serverQuality) request. 202. */
export interface PlatformEvalRunInsightsRequested {
  runId: string;
  projectId: string;
  status: "pending";
}

/**
 * Receipt for an eval-run judge request. 202 — grading runs async. Poll the run
 * detail's `judges.goalCompletion` rather than re-requesting.
 */
export interface PlatformEvalRunJudgeRequested {
  runId: string;
  projectId: string;
  status: "pending";
}

/** LLM analysis over a whole wave. Requested explicitly; produced async. */
export interface PlatformWaveInsights {
  waveId: string;
  /** pending | completed | failed. Poll rather than re-requesting. */
  status: "pending" | "completed" | "failed";
  /** Directed lane. Null until generation completes. */
  insights: unknown | null;
  /**
   * Discovery lane — what the model noticed unprompted. Null while only the
   * directed lane has finished, which is a normal intermediate state.
   */
  discovery: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: number;
}

/** Receipt for a wave-insights request. 202: scheduled, not done. */
export interface PlatformWaveInsightsRequested {
  waveId: string;
  projectId: string;
  status: "pending";
}

export interface PlatformWaveInsightsCanceled {
  waveId: string;
  projectId: string;
  canceled: true;
}

/**
 * What the caller may do in a project, so an agent on a static surface can
 * check before it plans rather than discovering a 403 mid-task.
 *
 * DESCRIPTIVE. Every enforcement point still runs on the write path; a stale
 * answer here produces the same clean denial it always would.
 */
export interface PlatformCapabilities {
  projectId: string;
  organizationId: string | null;
  /** Organization role: guest | member | admin | owner. */
  role: string;
  projectRole: string;
  /** Which channel the server resolved this request to. */
  surface: string;
  features: {
    sandboxes: {
      enabled: boolean;
      /** off | dark | enforce. Only `enforce` turns a disabled flag into a refusal. */
      mode: string;
      enforced: boolean;
      reason?: string;
    };
  };
  plan: {
    name: string;
    limits: Record<string, unknown>;
    features: Record<string, unknown>;
  } | null;
  /**
   * The booleans to branch on. Note that the exposure-REDUCING ones
   * (`cancelJourneyRun`, `unpublishUserTestingScenario`) stay true for an org
   * that has lost the beta — losing the feature is exactly when stopping it
   * matters most.
   */
  can: {
    readSwarms: boolean;
    readUserTesting: boolean;
    writeSwarms: boolean;
    launchJourneyRun: boolean;
    cancelJourneyRun: boolean;
    publishUserTestingScenario: boolean;
    unpublishUserTestingScenario: boolean;
    /**
     * Mode changes, member invites/removals, link rotation, renames — the
     * scenario controls an ordinary MEMBER can use. Guest execution is not
     * covered here; it is the one exposure control that needs admin, and it
     * has its own key below.
     */
    changeUserTestingExposure: boolean;
    /** The guest-execution spend caps. Genuinely project-admin upstream. */
    manageUserTestingGuestExecution: boolean;
    requestInsights: boolean;
    /** Reading eval suites, runs, iterations and traces. */
    readEvals: boolean;
    /** Authoring suites and cases — every eval write short of deleting. */
    writeEvalSuites: boolean;
    launchEvalRun: boolean;
    /**
     * Deleting a suite SOMEONE ELSE created — the project admin tier. The
     * creator of a suite may always delete it whatever their role, so a
     * `false` here does not mean you cannot delete your own.
     */
    deleteAnyEvalSuite: boolean;
    /** Same tier and same creator exception, for runs. */
    deleteAnyEvalRun: boolean;
    /**
     * Whether the trace export surface is open. Export still filters row by
     * row against the caller, so this is not a promise that every session in
     * the project lands in the file.
     */
    exportEvalTraces: boolean;
  };
}

/** A generated persona draft. Nothing is persisted until you create it. */
export interface PlatformPersonaDraft {
  name: string;
  role: string;
  notes?: string;
  [field: string]: unknown;
}

/** Draft output from the generation endpoints. Shape varies by request. */
export interface PlatformGenerationDrafts {
  [field: string]: unknown;
}

// ── User testing ────────────────────────────────────────────────────────────

/** One session a visitor had with a published scenario. SUMMARY, not transcript. */
export interface PlatformUserTestingSession {
  /** The address for the transcript route. */
  id: string;
  chatSessionId: string;
  messageCount: number;
  /** First message only. The transcript is a separate, explicit read. */
  preview: string;
  modelId?: string;
  toolCallCount?: number;
  /** The visitor abandoned mid-flow because a server demanded auth. */
  authInterrupted?: boolean;
  visitor: {
    displayName?: string;
    segment?: string;
    authType?: "signedIn" | "guest";
    recency?: "new" | "returning";
    deviceKind?: string;
    language?: string;
  };
  feedback: {
    rating: number | null;
    comment: string | null;
    count: number;
  };
  theme?: { id: string; label: string | null; keywords: string[] };
  startedAt: number;
  lastActivityAt: number;
}

/** One projected transcript message. Tool payloads and blobs are dropped. */
export interface PlatformTranscriptMessage {
  role: string;
  text: string;
  toolName?: string;
  createdAt?: number;
}

/**
 * A session's transcript, paged.
 *
 * The stored blob URL is never returned: it is a direct handle with no further
 * authorization, so handing it out would turn one authorized read into an
 * unbounded, unrevocable one.
 */
export interface PlatformUserTestingSessionDetail {
  id: string;
  scenarioId: string;
  chatSessionId: string | null;
  modelId: string | null;
  startedAt: number | null;
  lastActivityAt: number | null;
  /**
   * `null` — never 0 — when the transcript could not be read, which is why
   * this is nullable and the list DTO's is not. Zero would be a claim the
   * visitor said nothing, the opposite of what an unreadable blob means, and a
   * caller that only checked `messageCount` would act on it.
   */
  messageCount: number | null;
  /**
   * True when the stored conversation could not be read. Distinct from an
   * empty `messages`, which means the visitor genuinely said nothing.
   */
  transcriptUnavailable?: boolean;
  messages: PlatformTranscriptMessage[];
  nextCursor?: string;
}

/**
 * Scenario metadata after an update.
 *
 * NO `accessVersion`, deliberately: a mode change bumps it upstream, but the
 * envelope the route re-reads does not carry the new value, so the field was
 * null on every response while documenting itself as the revocation signal.
 * The publish response (`PlatformScenario`) carries the real one.
 */
export interface PlatformUserTestingScenario {
  id: string;
  projectId: string;
  name: string | null;
  description: string | null;
  mode: string | null;
}

/**
 * Scenario detail — the read shape, widened with the environment link and
 * the insights envelope.
 */
export interface PlatformUserTestingScenarioDetail
  extends PlatformUserTestingScenario {
  environmentId: string | null;
  /**
   * Present when the caller may have it. The envelope is gated on workspace
   * MEMBERSHIP while the scenario itself is visible more widely, so a
   * lower-privilege viewer gets the scenario without this field rather than
   * an error — same degradation as an older server that cannot produce one.
   */
  insights?: PlatformInsightsEnvelope;
}

/** Guest execution caps — the spend dial for anonymous visitors. */
export interface PlatformGuestExecution {
  enabled: boolean;
  computerEnabled: boolean;
  sharedSkillsEnabled: boolean;
  dailyCreditCap: number;
  dailyComputerStartCap: number;
  maxConcurrentComputers: number;
  harnessEnabled?: boolean;
  dailyHarnessSpendCapMicros?: number;
  dailyHarnessCallCap?: number;
  maxConcurrentHarnessRuns?: number;
}

export interface PlatformUserTestingInsightsRequested {
  scenarioId: string;
  projectId: string;
  windowId: string;
  status: "pending";
}

// ---------------------------------------------------------------------------
// Server connections
// ---------------------------------------------------------------------------

/**
 * One saved server a URL could refer to, offered when it matches more than one.
 *
 * Present only on an `AMBIGUOUS_SERVER` error. Without it that refusal is a
 * dead end on every surface that is not a browser: the caller is told to
 * re-send with a `serverId` and has no way to discover which ids exist.
 */
export interface PlatformServerConnectionCandidate {
  id: string;
  name: string;
  /** Redacted — query values are replaced, because a keyed-endpoint URL's
   * query can be the credential itself. */
  url: string;
}

export interface PlatformServerConnectionError {
  code: string;
  message: string;
  /** Whether retrying THIS request could succeed. False for a denied consent
   * or an unsupported auth method, where only a different action helps. */
  retryable: boolean;
  candidates?: PlatformServerConnectionCandidate[];
}

/**
 * The state of one "connect this MCP server" request.
 *
 * Returned by every server-connection route, so a caller polls the same shape
 * it created. `handoffUrl` is the exception that proves the rule: it appears
 * only in the CREATE response, because the raw handoff token exists exactly
 * once and nothing stores it.
 */
export interface PlatformServerConnection {
  connectionRequestId: string;
  status:
    | "discovering"
    | "awaiting_project"
    | "awaiting_authorization"
    | "authorizing"
    | "validating"
    | "ready"
    | "failed"
    | "expired"
    | "cancelled";
  /**
   * Where the user finishes in a browser. Present for BOTH
   * `awaiting_project` and `awaiting_authorization` — choosing a project needs
   * a page just as much as granting consent does.
   *
   * TREAT THIS AS PRIVATE. It is a capability for one person: never post it to
   * a shared channel, and never let a model echo it into prose.
   */
  handoffUrl?: string;
  expiresAt: string;
  projectId?: string;
  serverId?: string;
  server?: {
    id: string;
    name: string;
    url: string;
    enabled: boolean;
  };
  error?: PlatformServerConnectionError;
}

/** Body for `POST /server-connections`. */
export interface PlatformServerConnectionCreateBody {
  url: string;
  projectId?: string;
  /** Disambiguates when a project has several saved servers on one URL. */
  serverId?: string;
  /** Used only when a server row is created; ignored on reuse. */
  name?: string;
  reauthorize?: boolean;
}

// ── Directory readiness ─────────────────────────────────────────────────

/**
 * The two words the public vocabulary uses.
 *
 * Never `anthropic`/`chatgpt`: a caller writes what the product says, and the
 * product says "Claude directory readiness" and "OpenAI plugin directory".
 */
export type PlatformReadinessKind = "claude" | "openai";

/**
 * The submission shapes a HOSTED run may grade.
 *
 * The package shapes are real and are deliberately absent here: they need an
 * upload the API cannot receive, and they run on the local CLI. Listing them
 * in this type would let a caller write a request the server refuses.
 */
export type PlatformReadinessSubmissionMode =
  | "mcp-only"
  | "mcp-imported-skills";

export type PlatformReadinessLaneStatus = "ready" | "not-ready" | "incomplete";

/**
 * Every lane either publisher grades, as one union.
 *
 * Claude uses five of these and OpenAI seven; the union is their sum rather
 * than two types, because a client renders a run whose publisher it learns at
 * runtime. Spelled out rather than left as `string` so a `switch` over lane
 * copy is exhaustiveness-checked — a lane added here becomes a compile error
 * at every renderer instead of an unlabelled row in production.
 */
export type PlatformReadinessLane =
  | "runtime-compatibility"
  | "directory-policy"
  | "optional-features"
  | "submission-artifacts"
  | "experience-insights"
  | "plugin-package"
  | "release-contract";

/**
 * What one lane managed to look at, reported separately from what it found.
 *
 * A lane with zero violations and zero evaluated checks is not a pass, and
 * publishing the denominator is the only way to keep those apart.
 */
export interface PlatformReadinessLaneCoverage {
  lane: PlatformReadinessLane;
  status: PlatformReadinessLaneStatus;
  evaluated: number;
  notEvaluated: number;
  notApplicable: number;
  /** Named inputs the caller could supply to close the gap. */
  missingInputs: string[];
}

export interface PlatformReadinessStageResult {
  stage: "technical-preflight" | "submission-ready";
  status: PlatformReadinessLaneStatus;
  lanes: PlatformReadinessLane[];
}

/**
 * The model-observation axis, INDEPENDENT of the run's own status.
 *
 * `billing_limit_reached` is the value a client keys a top-up prompt on — it
 * is machine-readable precisely so nobody has to string-match `detail`.
 */
export interface PlatformReadinessObservationState {
  status:
    | "not-requested"
    | "pending"
    | "completed"
    | "billing-blocked"
    | "provider-failed"
    | "invalid-output";
  reason?:
    | "not_requested"
    | "billing_limit_reached"
    | "provider_error"
    | "provider_timeout"
    | "schema_invalid"
    | "no_evidence"
    | "cancelled";
  detail?: string;
}

export interface PlatformReadinessRun {
  id: string;
  readinessKind: PlatformReadinessKind;
  /** Null only on rows written before the field existed. */
  serverId: string | null;
  serverUrl: string;
  submissionMode: PlatformReadinessSubmissionMode | null;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  overallStatus: PlatformReadinessLaneStatus | null;
  lanes: PlatformReadinessLaneCoverage[];
  stages: PlatformReadinessStageResult[];
  authMode: "headless" | "interactive" | "provided-token" | null;
  capabilities: string[];
  attemptCount: number;
  terminalReason: string | null;
  errorMessage: string | null;
  policySnapshotDate: string | null;
  engineVersion: string | null;
  sdkVersion: string | null;
  includeLlmObservations: boolean;
  llmObservations: PlatformReadinessObservationState;
  hasReport: boolean;
  reportUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The `202` receipt. Poll the run detail; do not re-POST. */
export interface PlatformReadinessRunReceipt {
  runId: string;
  projectId: string;
  serverId: string;
  readinessKind: PlatformReadinessKind;
  /**
   * The run's status at the moment the start returned.
   *
   * `pending` for a fresh start. For a DEDUPED start it is whatever the
   * existing run is already at — which may be `completed`, because an
   * idempotency key replayed hours later names a run that finished long ago.
   * Reporting `pending` unconditionally would send such a caller into a poll
   * loop for a result it could already read.
   */
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  /** True when an idempotency key replayed an existing run. */
  deduped: boolean;
  includeLlmObservations: boolean;
}

/** Fields both start endpoints accept. */
export interface PlatformReadinessStartBody {
  /**
   * Deduplicates a retried POST.
   *
   * More load-bearing here than usual: a readiness run dials a third party's
   * server, and a retried start that created a second run would do that twice.
   */
  idempotencyKey?: string;
  /**
   * Add model-backed experience observations. CONSUMES MCPJam CREDITS.
   *
   * Off by default. Observations are non-dispositive — they can never make a
   * server not-ready — and a refused reservation makes no provider call and
   * completes the run with `llmObservations.reason` of
   * `billing_limit_reached`.
   */
  includeLlmObservations?: boolean;
}

export interface PlatformOpenAIReadinessStartBody
  extends PlatformReadinessStartBody {
  /**
   * The DECLARED submission shape. REQUIRED, and never inferred.
   *
   * Inference reads a forgotten package as `mcp-only`, which reports the
   * package lane not-applicable — turning a missing input into a clean bill of
   * health.
   */
  submissionMode: PlatformReadinessSubmissionMode;
}

/** Suites the hosted agent/API surface can start. OAuth is refused. */
export type PlatformConformanceSuiteKind = "protocol" | "apps" | "tasks";

/** The `202` receipt. Poll the run detail; do not re-POST. */
export interface PlatformConformanceRunReceipt {
  runId: string;
  projectId: string;
  serverId: string;
  /**
   * The run's status at the moment the start returned.
   *
   * `queued` for a fresh start. For a DEDUPED start it is whatever the
   * existing run is already at — which may be `completed`.
   */
  status: string;
  /** True when an idempotency key replayed an existing run. */
  deduped: boolean;
  requestedSuites: PlatformConformanceSuiteKind[];
}

export interface PlatformConformanceRunReportSummary {
  suiteKind: string;
  status: string;
  outcome: string | null;
  score: number | null;
  pending: number;
  profileId: string | null;
  profileVersion: string | null;
  hasReport: boolean;
}

export interface PlatformConformanceRun {
  id: string;
  projectId: string;
  serverId: string | null;
  source: string | null;
  verification: string | null;
  status: string;
  outcome: string | null;
  incompleteReason: string | null;
  score: number | null;
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  notApplicable: number;
  pending: number;
  advisoryCount: number;
  requestedSuites: string[];
  protocolVersion: string | null;
  engineVersion: string | null;
  createdAt: number;
  completedAt: number | null;
  durationMs: number | null;
  reports: PlatformConformanceRunReportSummary[];
  /** Relative v1 report URL when a stored report exists (or the run is terminal). */
  reportUrl: string | null;
}

export interface PlatformConformanceReportCheck {
  suiteKind: string;
  id: string;
  title: string;
  groupId: string;
  status: string;
  pending: boolean;
  skipReason?: string;
  error?: string;
}

export interface PlatformConformanceReportProfile {
  suiteKind: string;
  profileId: string | null;
  profileVersion: string | null;
  pendingCheckIds: string[];
}

/** Bounded failing-check projection. The stored report can be megabytes. */
export interface PlatformConformanceReport {
  runId: string;
  status: string;
  outcome: string | null;
  score: number | null;
  pending: number;
  checks: PlatformConformanceReportCheck[];
  totalCases: number;
  /** Failed + could-not-run count, the denominator behind `truncated`. */
  totalFailingCases: number;
  truncated: boolean;
  profiles: PlatformConformanceReportProfile[];
}
