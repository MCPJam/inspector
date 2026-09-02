import { UIMessage } from "ai";
import type { ModelDefinition } from "./types";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@mcpjam/sdk/host-config";
import type {
  EnvironmentOverrides,
  HostedExecutionTarget,
} from "./execution-target";
import type {
  ScopeStepUpCancelRequest,
  ScopeStepUpResumeRequest,
} from "./scope-step-up";

export interface ChatRewind {
  parentChatSessionId: string;
  rewoundFromMessageId: string;
  reason: "message_edit";
}

export interface ChatV2Request {
  messages: UIMessage[];
  /**
   * WHAT this turn executes against (Project Environments — Phase 1.1). One
   * pointer, ids only; the server re-resolves the authoritative configuration.
   *
   * Mutually exclusive with the legacy top-level `hostId` and with the
   * access-bearing `scenarioId` — the hosted ingress REJECTS those combinations
   * rather than picking a winner (`shared/execution-target.ts`). Absent ⇒ the
   * legacy behavior is unchanged.
   */
  executionTarget?: HostedExecutionTarget;
  /**
   * Per-turn narrowing of an environment target's server set. Only valid
   * alongside an `environment` execution target. Absent means "use the
   * environment"; `[]` means "no MCP servers this turn" — the two are
   * deliberately different.
   */
  environmentOverrides?: EnvironmentOverrides;
  chatSessionId?: string;
  /** Lineage for a new session created by editing an earlier user message. */
  rewind?: ChatRewind;
  /** Userless retry of a tool call suspended for SEP-2350 authorization. */
  scopeStepUpResume?: ScopeStepUpResumeRequest;
  /** Userless resolution when the user denied or failed authorization. */
  scopeStepUpCancel?: ScopeStepUpCancelRequest;
  directVisibility?: "private" | "project";
  surface?: "preview" | "share_link";
  serverName?: string;
  serverUrl?: string;
  serverHeaders?: Record<string, string>;
  oauthAccessToken?: string;
  clientCapabilities?: Record<string, unknown>;
  model?: ModelDefinition;
  modelId?: string;
  systemPrompt?: string;
  temperature?: number;
  apiKey?: string;
  ollamaBaseUrl?: string;
  azureBaseUrl?: string;
  customProviders?: Array<{
    name: string;
    protocol: string;
    baseUrl: string;
    modelIds: string[];
    apiKey?: string;
  }>;
  selectedServers?: string[];
  selectedServerNames?: string[];
  /**
   * Convex `Id<'servers'>` for each selected server, parallel to
   * `selectedServers`. Local mode only fills this when the user is signed in
   * and every selected server is synced to Convex — so consumers must treat a
   * missing or short array as "no real Ids available" and not as `[]`. The
   * hosted web route gets real Ids from a separate request schema.
   */
  selectedServerIds?: string[];
  /**
   * Local inspector must own the tool loop for this turn because at least one
   * selected MCP server is reachable only from this machine (stdio, localhost,
   * or private IP HTTP). For org BYOK, the server forces the cloud runtime so
   * the model call is proxied through Convex (`/stream/org`) — the org key
   * stays in Convex and is never sent to the inspector — while the tool loop
   * still runs locally against the local MCP connection.
   */
  localMcpRuntimeRequired?: boolean;
  requireToolApproval?: boolean;
  /**
   * HostConfig v2 built-in tool ids (e.g. `["web_search"]`) the client wants
   * advertised this turn. For scenario-bound requests the server re-resolves
   * from the host's pinned config (host wins); for playground/direct chat the
   * body value is used as-is. Billing authorization happens server-side in
   * Convex (bearer + projectId), so a tampered body can't bill a project the
   * caller isn't authorized on.
   */
  builtInToolIds?: string[];
  /**
   * What the hosted `browser_*` tools may do in an UNATTENDED run (eval,
   * swarm, journey). Those runs never pause, so approval — the mechanism
   * every interactive surface relies on — does not exist for them; a declared
   * policy is the substitute, and WITHOUT one the browser tools are simply
   * not advertised (fail-closed, see `built-in-tools/browser.ts`).
   *
   * Ignored on interactive surfaces, which gate through approval instead.
   */
  browserToolPolicy?: {
    mode: "allow_all" | "read_only" | "allowlist";
    originAllowlist?: string[];
    toolAllowlist?: string[];
  };
  /**
   * Host-level opt-in for progressive MCP tool discovery
   * (`search_mcp_tools` / `load_mcp_tools` meta-tools instead of sending
   * every tool definition every turn). Sourced from the project's default
   * HostConfigV2 toggle. `undefined` → use the backend's auto policy;
   * explicit `true`/`false` → force on/off for this request.
   */
  progressiveToolDiscovery?: boolean;
  /**
   * SEP-1865 visibility filter switch (see HostConfigInputV2.respectToolVisibility).
   * Optional — `undefined` means "use the spec default" (filter app-only
   * tools). The server re-resolves from the persisted host config when
   * the request is scenario-bound, so the host value wins.
   */
  respectToolVisibility?: boolean;
  /** Host-level MCP tool-result content/resource visibility policy. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /** Host-level UI rendering policy for MCP tool-returned images. */
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  /**
   * Phase 3 read switch: real host style for direct chat traces. When
   * unset, the backend's chatIngestion path defaults to `'claude'` —
   * so existing call sites that don't yet thread this through still
   * produce a v2 hostConfig with a real (non-`'direct'`) hostStyle.
   * Old inspector builds will keep emitting nothing or `'direct'`;
   * the backend accepts both and normalizes with a
   * `legacy_direct_style` warn.
   */
  hostStyle?: string;
  /**
   * Project ID for direct-chat history persistence and, when set, the server
   * resolves model-provider config from the org backing this project.
   */
  projectId?: string;
  /** Version for optimistic concurrency on resumed threads */
  expectedVersion?: number;
  /**
   * SEP-1865 App-Provided Tools snapshot — per chat POST.
   *
   * Aliased upstream by the client registry
   * (`client/src/components/chat-v2/thread/mcp-apps/app-tools-registry.ts`).
   * The server defends the boundary again in `validateAppToolEntries`
   * (caps, alias regex, schema size). `readOnly` is metadata, not an
   * inclusion gate.
   */
  appTools?: AppToolSnapshotEntry[];
  /**
   * WebMCP tools registered by a page the WebMCP Inspector has open, snapshotted
   * per turn from the inspector store.
   *
   * Client-fulfilled like `appTools`: the model's call comes back to the browser,
   * which invokes it through the inspector session and supplies the result. The
   * server validates the boundary again in `validatePageToolEntries` and gates
   * EVERY call for approval — these run code on a third-party site, and the only
   * claims about what they do come from that site.
   *
   * Local surfaces only: the inspector session lives in the local server's
   * process, so a hosted turn has nothing to resolve these against.
   */
  pageTools?: PageToolSnapshotEntry[];
  /**
   * SEP-1865 `ui/update-model-context` snapshots for the next model turn.
   *
   * These are per-request, ephemeral model context: the server appends them
   * to the outbound prompt for this turn, but they are not inserted into the
   * user-visible chat transcript.
   */
  widgetModelContext?: WidgetModelContextEntry[];
}

/**
 * SEP-1865 App-Provided Tool snapshot entry. Mirrors
 * `AppToolEntry` in `server/utils/chat-v2-orchestration.ts` so the
 * client snapshotter and the server validator share a single shape.
 *
 * `alias` is opaque (`app_<8hex>`), validated at the boundary, and used
 * as the AI SDK tool name. `rawName` is preserved only for logging
 * and dispatch (`useChat.onToolCall` resolves alias → rawName via the
 * registry).
 */
export interface AppToolSnapshotEntry {
  alias: string;
  appName: string;
  appVersion?: string;
  serverId: string;
  parentToolCallId: string;
  rawName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
}

/**
 * One WebMCP page tool as the client advertises it for a turn.
 *
 * `alias` is what the model sees (page-authored names are arbitrary and would
 * not survive the provider tool-name charset); `toolKey` is what the inspector
 * invokes by, and `sessionId` says which open browser it belongs to.
 */
export interface PageToolSnapshotEntry {
  alias: string;
  sessionId: string;
  toolKey: string;
  rawName: string;
  origin: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface WidgetModelContextEntry {
  toolCallId: string;
  context: {
    content?: Record<string, unknown>[];
    structuredContent?: Record<string, unknown>;
  };
}
