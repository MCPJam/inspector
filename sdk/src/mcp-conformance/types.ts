import type {
  ConformanceRunOutcome,
  ConformanceSkipReason,
} from "../conformance-outcome.js";
import type {
  ManagedMcpClient,
  MCPClientManager,
} from "../mcp-client-manager/index.js";
import type { McpProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";
import type { Tool } from "@modelcontextprotocol/client";

export const MCP_CHECK_CATEGORIES = [
  "core",
  "protocol",
  "tools",
  "prompts",
  "resources",
  "security",
  "transport",
] as const;

export type MCPCheckCategory = (typeof MCP_CHECK_CATEGORIES)[number];

export const MCP_CHECK_IDS = [
  "server-initialize",
  "ping",
  "logging-set-level",
  "completion-complete",
  "capabilities-consistent",
  "tools-list",
  "tools-input-schemas-valid",
  // SEP-2243 (2026-07-28): `x-mcp-header` declarations are part of the tool
  // DEFINITION's validity, not of any one call — a conforming client "MUST
  // treat the tool definition as invalid" when a declaration breaks any of the
  // constraints. Modern-only, because the annotation has no meaning before
  // 2026-07-28: flagging it on a 2025 run would invent a requirement.
  "tools-x-mcp-header-declarations-valid",
  "prompts-list",
  "resources-list",
  "protocol-invalid-method-error",
  "localhost-host-rebinding-rejected",
  "localhost-host-valid-accepted",
  "server-sse-polling-session",
  "server-accepts-multiple-post-streams",
  "server-sse-streams-functional",
  // Streamable HTTP transport MUSTs stated verbatim by the 2025 revisions:
  // a notification-only POST answers `202 Accepted` with no body, a GET either
  // opens an SSE stream or answers 405, and a minted session id contains only
  // visible ASCII (0x21–0x7E). All three mechanics were removed by 2026-07-28,
  // so they are legacy-only.
  "notification-post-accepted",
  "get-stream-or-405",
  "session-id-visible-ascii",
  // Every revision, 2025-03-26 through 2026-07-28: the response to a JSON-RPC
  // request MUST carry `Content-Type: application/json` or `text/event-stream`
  // — the CHOICE between them is the server's, so this asserts membership only.
  "post-response-content-type",
  // Phase 7 §15.3 — modern (2026-07-28) MUST checks. New ids rather than
  // reused legacy ones: each asserts a requirement that did not exist (or
  // changed materially) in the 2025 era, so a shared id would make a legacy
  // report and a modern report mean different things under the same name.
  "modern-client-handshake",
  "modern-server-discover",
  "modern-result-type-present",
  "modern-cacheable-result-hints",
  "modern-protocol-version-header-mismatch",
  "modern-method-header-mismatch",
  "modern-name-header-mismatch",
  "modern-unsupported-version-error",
  "modern-undeclared-capability-error",
  "modern-no-session-id",
  "modern-removed-methods-not-found",
  "modern-resource-not-found-invalid-params",
  "modern-logs-require-log-level",
  "modern-subscription-ack-precedes-notifications",
  "modern-subscription-filter-and-tagging",
  "modern-subscription-graceful-close",
] as const;

export type MCPCheckId = (typeof MCP_CHECK_IDS)[number];

export type MCPCheckStatus = "passed" | "failed" | "skipped";

/** @see {@link ConformanceSkipReason} — the vocabulary is shared by every suite. */
export type MCPCheckSkipReason = ConformanceSkipReason;

/** @see {@link ConformanceRunOutcome} — the vocabulary is shared by every suite. */
export type MCPRunOutcome = ConformanceRunOutcome;

/**
 * Protocol era a conformance run targets. Derived once in
 * {@link NormalizedMCPConformanceConfig} from the pinned `protocolVersion`
 * (via `isStatelessProtocolVersion`): a stateless/2026-era pin ⇒ `"modern"`,
 * an absent or stateful pin ⇒ `"legacy"`. An absent pin therefore reproduces
 * byte-identical legacy behavior.
 */
export type MCPCheckEra = "legacy" | "modern";

/**
 * Era membership for a check: a NON-EMPTY list. Typing it as a non-empty tuple
 * is the second half of the §15.1 exhaustiveness guarantee — `CHECK_ERAS` is
 * already total over `MCPCheckId`, and this makes `[]` (a check that silently
 * applies to no era, i.e. is dead everywhere) a compile error too.
 */
export type MCPCheckEras = readonly [MCPCheckEra, ...MCPCheckEra[]];

/**
 * Era of every protocol version the SDK can be pinned to — the version half of
 * the §15.1 registry.
 *
 * `satisfies Record<McpProtocolVersion, MCPCheckEra>` makes this map TOTAL over
 * `MCP_PROTOCOL_VERSIONS`: adding a supported protocol version is therefore a
 * compile-time obligation to state which era's check set it runs, instead of
 * silently inheriting "unknown ⇒ legacy". Derivation from
 * `isStatelessProtocolVersion` is deliberately NOT used here — that predicate
 * answers "not on the stateful list", which is the wrong default for a version
 * nobody has classified yet.
 */
export const PROTOCOL_VERSION_ERAS = {
  "2025-03-26": "legacy",
  "2025-06-18": "legacy",
  "2025-11-25": "legacy",
  "2026-07-28": "modern",
} as const satisfies Record<McpProtocolVersion, MCPCheckEra>;

/** Every classified protocol version, for exhaustiveness assertions. */
export const MCP_PROTOCOL_VERSION_ERA_IDS = Object.keys(
  PROTOCOL_VERSION_ERAS
) as McpProtocolVersion[];

/**
 * Single source of truth mapping each check to the eras it applies to.
 * Consumed by BOTH tracks — the client-backed checks (via `eraGate` in the
 * runner) and the raw-HTTP checks (protocol/security/transport runners) —
 * so era membership is never duplicated or allowed to drift between them.
 * Phase 7 (modern MUST checks) reuses this map rather than re-deriving.
 *
 * Classification rationale:
 *   - Legacy-only checks assert 2025-era wire mechanics that do not exist in
 *     the sessionless 2026 era: the `initialize` handshake
 *     (`server-initialize`), the stateful session id + concurrent POST/SSE
 *     stream semantics (`server-sse-*`, `server-accepts-multiple-post-streams`),
 *     and consistency/health probes (`capabilities-consistent`, `ping`) whose
 *     modern equivalents are Phase 7 work.
 *   - Both-era checks either self-skip on an unadvertised capability
 *     (`logging-set-level`, `completion-complete`) or assert primitive
 *     surface / generic JSON-RPC behavior that is era-agnostic
 *     (`tools-list`, `tools-input-schemas-valid`, `prompts-list`,
 *     `resources-list`, `protocol-invalid-method-error`).
 *   - `tools-x-mcp-header-declarations-valid` is modern-only WITHOUT a
 *     `modern-` prefix: it belongs to the tools family (it judges tool
 *     definitions a `tools/list` already returned, sending no probe), but
 *     `x-mcp-header` has no meaning before 2026-07-28, so asserting it on a
 *     2025 run would invent a requirement the revision never stated.
 *
 * The two `localhost-host-*` security checks are deliberately legacy-only for
 * now: their raw modern host-header probe could not be validated against the
 * dual-era fixture (which leaves DNS-rebinding protection disabled), so per
 * the Phase 3 safety valve they are downgraded to a safe skip on a modern run
 * rather than shipped as a fragile probe.
 *
 * Phase 7 additions:
 *   - The `modern-*` checks are modern-only. On a legacy run they era-skip, so
 *     a legacy report keeps exactly the statuses it had before this phase.
 *   - `capabilities-consistent` is promoted to BOTH eras: the requirement
 *     ("what you advertise is what you expose") is unchanged by the era, only
 *     the transport that carries the advertisement is (initialize ⇒
 *     server/discover), so the id is preserved rather than renamed.
 *   - `server-initialize` and `ping` STAY legacy-only: `initialize` and `ping`
 *     were removed from the 2026 wire (a modern server answers -32601), so on
 *     a modern run they are era-skipped and `modern-client-handshake` /
 *     `modern-removed-methods-not-found` carry the equivalent evidence.
 *   - The three `modern-subscription-*` checks are modern-only for the
 *     strongest possible reason: `subscriptions/listen` does not exist on the
 *     2025 wire at all, so there is nothing for them to assert on a legacy
 *     run. They observe ONE real listen stream (see `raw-listen.ts`) and skip
 *     — never fail — when the server advertises nothing subscribable, refuses
 *     to open a stream, or keeps the subscription open past the observation
 *     window (a graceful close is server-initiated and cannot be induced by a
 *     client-side probe).
 */
export const CHECK_ERAS: Record<MCPCheckId, MCPCheckEras> = {
  "server-initialize": ["legacy"],
  ping: ["legacy"],
  "capabilities-consistent": ["legacy", "modern"],
  "server-sse-polling-session": ["legacy"],
  "server-accepts-multiple-post-streams": ["legacy"],
  "server-sse-streams-functional": ["legacy"],
  // Client-to-server notifications, the GET stream endpoint, and sessions were
  // all removed by 2026-07-28 (the revision even states that header
  // requirements for a notification POST are undefined), so these three have
  // nothing to assert on a modern run.
  "notification-post-accepted": ["legacy"],
  "get-stream-or-405": ["legacy"],
  "session-id-visible-ascii": ["legacy"],
  // The response-Content-Type MUST is stated identically by every revision.
  "post-response-content-type": ["legacy", "modern"],
  "localhost-host-rebinding-rejected": ["legacy"],
  "localhost-host-valid-accepted": ["legacy"],
  "tools-list": ["legacy", "modern"],
  "tools-input-schemas-valid": ["legacy", "modern"],
  "tools-x-mcp-header-declarations-valid": ["modern"],
  "prompts-list": ["legacy", "modern"],
  "resources-list": ["legacy", "modern"],
  "logging-set-level": ["legacy", "modern"],
  "completion-complete": ["legacy", "modern"],
  "protocol-invalid-method-error": ["legacy", "modern"],
  "modern-client-handshake": ["modern"],
  "modern-server-discover": ["modern"],
  "modern-result-type-present": ["modern"],
  "modern-cacheable-result-hints": ["modern"],
  "modern-protocol-version-header-mismatch": ["modern"],
  "modern-method-header-mismatch": ["modern"],
  "modern-name-header-mismatch": ["modern"],
  "modern-unsupported-version-error": ["modern"],
  "modern-undeclared-capability-error": ["modern"],
  "modern-no-session-id": ["modern"],
  "modern-removed-methods-not-found": ["modern"],
  "modern-resource-not-found-invalid-params": ["modern"],
  "modern-logs-require-log-level": ["modern"],
  "modern-subscription-ack-precedes-notifications": ["modern"],
  "modern-subscription-filter-and-tagging": ["modern"],
  "modern-subscription-graceful-close": ["modern"],
} as const satisfies Record<MCPCheckId, MCPCheckEras>;

export interface MCPCheckResult {
  id: MCPCheckId;
  category: MCPCheckCategory;
  title: string;
  description: string;
  status: MCPCheckStatus;
  /** Always set when `status` is `"skipped"`. */
  skipReason?: MCPCheckSkipReason;
  durationMs: number;
  error?: {
    message: string;
    details?: unknown;
  };
  details?: Record<string, unknown>;
}

export interface MCPConformanceConfig {
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
  checkTimeout?: number;
  categories?: MCPCheckCategory[];
  checkIds?: MCPCheckId[];
  fetchFn?: typeof fetch;
  clientName?: string;
  /**
   * Pinned MCP protocol version. Absent ⇒ legacy era, byte-identical to the
   * pre-era-awareness behavior. A known stateless value (e.g. `"2026-07-28"`)
   * selects the modern era: the client connects through the official Client's
   * version negotiation and era-scoped checks apply per {@link CHECK_ERAS}.
   * Validated at normalization via `isKnownProtocolVersion`.
   */
  protocolVersion?: McpProtocolVersion;
  /**
   * Tool the `modern-undeclared-capability-error` check may call to make the
   * server attempt an `input_required` round trip (MCP 2026-07-28 §12).
   *
   * Opt-in on purpose: the check has to actually EXECUTE a tool, and no
   * advertised metadata says which tool will ask for input, so guessing would
   * mean firing arbitrary side-effecting tools at the server under test.
   * Absent ⇒ the check reports a skip explaining what it needs.
   */
  inputRequiredProbe?: {
    toolName: string;
    arguments?: Record<string, unknown>;
  };
  /**
   * Tool the `modern-logs-require-log-level` check may call to make the server
   * actually EMIT log records. Opt-in for the same reason as
   * {@link MCPConformanceConfig.inputRequiredProbe}: no metadata says which
   * tool logs, and the check must not fire arbitrary side-effecting tools.
   *
   * Absent ⇒ the check still asserts the MUST against an ordinary request
   * (any log record on a level-less request is a violation), but it cannot
   * show the server logs at all, so the evidence is weaker.
   */
  logProbe?: {
    toolName: string;
    arguments?: Record<string, unknown>;
  };
}

export interface NormalizedMCPConformanceConfig {
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
  checkTimeout: number;
  categories: MCPCheckCategory[];
  checkIds?: MCPCheckId[];
  fetchFn: typeof fetch;
  clientName: string;
  /** Validated protocol pin (see {@link MCPConformanceConfig.protocolVersion}). */
  protocolVersion?: McpProtocolVersion;
  /** Era derived from `protocolVersion`; absent pin ⇒ `"legacy"`. */
  era: MCPCheckEra;
  /** See {@link MCPConformanceConfig.inputRequiredProbe}. */
  inputRequiredProbe?: {
    toolName: string;
    arguments?: Record<string, unknown>;
  };
  /** See {@link MCPConformanceConfig.logProbe}. */
  logProbe?: {
    toolName: string;
    arguments?: Record<string, unknown>;
  };
}

/**
 * What the client phase found on the server, handed to the raw track and the
 * readiness pass so neither has to re-discover it (and so a raw probe targets
 * a REAL primitive instead of a guessed name).
 */
export interface MCPServerSurfaceSnapshot {
  tools: Tool[];
  toolNames: string[];
  promptNames: string[];
  resourceUris: string[];
  resourceTemplateUris: string[];
  serverCapabilities?: Record<string, unknown>;
}

/** Readiness advice ids (Phase 7 §15.4). Never part of the pass/fail verdict. */
export const MCP_READINESS_IDS = [
  "readiness-tool-order-deterministic",
  "readiness-metadata-quality",
  "readiness-deprecated-feature-use",
  "readiness-cache-ttl-useful",
  "readiness-oauth-iss-advertised",
  "readiness-x-mcp-header-declarations",
  // No revision maps an unparseable POST body to any HTTP status or JSON-RPC
  // error — the transports docs are silent — so answering garbage with a
  // success status is ADVICE (JSON-RPC 2.0 names -32700 for it), never a
  // violation.
  "readiness-parse-error-handling",
  // Explicit session termination is SHOULD (client-side) / MAY (server-side)
  // on the 2025 revisions, and 405-on-GET/DELETE is the 2026 revision's
  // backward-compat SHOULD; neither can fail a run.
  "readiness-session-termination",
] as const;

export type MCPReadinessId = (typeof MCP_READINESS_IDS)[number];

/**
 * How strongly the spec states the advice. Everything on the readiness channel
 * is SHOULD/RECOMMENDED/MAY strength by construction — a MUST belongs in
 * {@link MCP_CHECK_IDS}, where it can fail the run.
 */
export type MCPReadinessSpecStrength = "SHOULD" | "RECOMMENDED" | "MAY";

export interface MCPReadinessWarning {
  id: MCPReadinessId;
  title: string;
  /** Always `"warning"`: the readiness channel has no failure severity. */
  severity: "warning";
  specStrength: MCPReadinessSpecStrength;
  message: string;
  details?: Record<string, unknown>;
}

export interface MCPConformanceResult {
  /**
   * True ONLY when `outcome` is `"passed"`: every selected check either ran and
   * passed or was inapplicable to this server. A check that could not run keeps
   * this false, so a skip can never add up to a green run.
   */
  passed: boolean;
  outcome: MCPRunOutcome;
  /**
   * Present when `outcome` is `"incomplete"`: which checks did not run and what
   * the caller has to change to make them run.
   */
  incompleteReason?: string;
  serverUrl: string;
  /**
   * The revision this run was judged against: the caller's pin, or the
   * version the server negotiated when the run connected without one. Absent
   * when an unpinned run never connected (raw-only selection) — the run
   * established no version, and a score label must not invent one.
   */
  protocolVersion?: McpProtocolVersion;
  checks: MCPCheckResult[];
  summary: string;
  durationMs: number;
  categorySummary: Record<
    MCPCheckCategory,
    {
      total: number;
      passed: number;
      failed: number;
      /** Every skip, of either reason. */
      skipped: number;
      /** The subset of `skipped` that is `"could-not-run"`. */
      couldNotRun: number;
    }
  >;
  /**
   * Interoperability advice observed during the run (Phase 7 §15.4). These are
   * NON-MUST findings: they are reported so a server author can improve
   * real-world interop, and they NEVER affect `passed` or any check status.
   */
  readiness: MCPReadinessWarning[];
}

export interface MCPConformanceSuiteConfig {
  name?: string;
  serverUrl: string;
  defaults?: Partial<Omit<MCPConformanceConfig, "serverUrl">>;
  runs: Array<
    Partial<Omit<MCPConformanceConfig, "serverUrl">> & { label?: string }
  >;
}

export interface MCPConformanceSuiteResult {
  name: string;
  serverUrl: string;
  passed: boolean;
  results: Array<MCPConformanceResult & { label: string }>;
  summary: string;
  durationMs: number;
}

export interface MCPClientCheckContext {
  manager: MCPClientManager;
  client: ManagedMcpClient;
  serverId: string;
  config: NormalizedMCPConformanceConfig;
  initializationInfo: ReturnType<MCPClientManager["getInitializationInfo"]>;
  availableTools: string[];
  availablePrompts: string[];
  availableResources: string[];
  availableResourceTemplates: string[];
}

export interface RawHttpCheckContext {
  config: NormalizedMCPConformanceConfig;
  serverUrl: string;
  fetchFn: typeof fetch;
  /** Absent when the run selected raw-only checks and never connected. */
  surface?: MCPServerSurfaceSnapshot;
}

export interface MCPClientCheckDefinition {
  id: MCPCheckId;
  category: Extract<
    MCPCheckCategory,
    "core" | "tools" | "prompts" | "resources"
  >;
  title: string;
  description: string;
  run: (ctx: MCPClientCheckContext) => Promise<MCPCheckResult>;
}
