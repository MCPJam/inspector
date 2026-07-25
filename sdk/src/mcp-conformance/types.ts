import type {
  ManagedMcpClient,
  MCPClientManager,
} from "../mcp-client-manager/index.js";
import type { McpProtocolVersion } from "../mcp-client-manager/mcp-protocol-version.js";

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
  "prompts-list",
  "resources-list",
  "protocol-invalid-method-error",
  "localhost-host-rebinding-rejected",
  "localhost-host-valid-accepted",
  "server-sse-polling-session",
  "server-accepts-multiple-post-streams",
  "server-sse-streams-functional",
] as const;

export type MCPCheckId = (typeof MCP_CHECK_IDS)[number];

export type MCPCheckStatus = "passed" | "failed" | "skipped";

/**
 * Protocol era a conformance run targets. Derived once in
 * {@link NormalizedMCPConformanceConfig} from the pinned `protocolVersion`
 * (via `isStatelessProtocolVersion`): a stateless/2026-era pin ⇒ `"modern"`,
 * an absent or stateful pin ⇒ `"legacy"`. An absent pin therefore reproduces
 * byte-identical legacy behavior.
 */
export type MCPCheckEra = "legacy" | "modern";

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
 *
 * The two `localhost-host-*` security checks are deliberately legacy-only for
 * now: their raw modern host-header probe could not be validated against the
 * dual-era fixture (which leaves DNS-rebinding protection disabled), so per
 * the Phase 3 safety valve they are downgraded to a safe skip on a modern run
 * rather than shipped as a fragile probe. Promoting them is Phase 7 work.
 */
export const CHECK_ERAS: Record<MCPCheckId, readonly MCPCheckEra[]> = {
  "server-initialize": ["legacy"],
  ping: ["legacy"],
  "capabilities-consistent": ["legacy"],
  "server-sse-polling-session": ["legacy"],
  "server-accepts-multiple-post-streams": ["legacy"],
  "server-sse-streams-functional": ["legacy"],
  "localhost-host-rebinding-rejected": ["legacy"],
  "localhost-host-valid-accepted": ["legacy"],
  "tools-list": ["legacy", "modern"],
  "tools-input-schemas-valid": ["legacy", "modern"],
  "prompts-list": ["legacy", "modern"],
  "resources-list": ["legacy", "modern"],
  "logging-set-level": ["legacy", "modern"],
  "completion-complete": ["legacy", "modern"],
  "protocol-invalid-method-error": ["legacy", "modern"],
} as const satisfies Record<MCPCheckId, readonly MCPCheckEra[]>;

export interface MCPCheckResult {
  id: MCPCheckId;
  category: MCPCheckCategory;
  title: string;
  description: string;
  status: MCPCheckStatus;
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
}

export interface MCPConformanceResult {
  passed: boolean;
  serverUrl: string;
  checks: MCPCheckResult[];
  summary: string;
  durationMs: number;
  categorySummary: Record<
    MCPCheckCategory,
    {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
    }
  >;
}

export interface MCPConformanceSuiteConfig {
  name?: string;
  serverUrl: string;
  defaults?: Partial<Omit<MCPConformanceConfig, "serverUrl">>;
  runs: Array<Partial<Omit<MCPConformanceConfig, "serverUrl">> & { label?: string }>;
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
}

export interface MCPClientCheckDefinition {
  id: MCPCheckId;
  category: Extract<MCPCheckCategory, "core" | "tools" | "prompts" | "resources">;
  title: string;
  description: string;
  run: (ctx: MCPClientCheckContext) => Promise<MCPCheckResult>;
}
