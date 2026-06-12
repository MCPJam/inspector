import { UIMessage } from "ai";
import type { ModelDefinition } from "./types";

export interface ChatV2Request {
  messages: UIMessage[];
  chatSessionId?: string;
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
  requireToolApproval?: boolean;
  /**
   * HostConfig v2 built-in tool ids (e.g. `["web_search"]`) the client wants
   * advertised this turn. For chatbox-bound requests the server re-resolves
   * from the host's pinned config (host wins); for playground/direct chat the
   * body value is used as-is. Billing authorization happens server-side in
   * Convex (bearer + projectId), so a tampered body can't bill a project the
   * caller isn't authorized on.
   */
  builtInToolIds?: string[];
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
   * the request is chatbox-bound, so the host value wins.
   */
  respectToolVisibility?: boolean;
  /**
   * Phase 3 read switch: real host style for direct chat traces. When
   * unset, the backend's chatIngestion path defaults to `'claude'` —
   * so existing call sites that don't yet thread this through still
   * produce a v2 hostConfig with a real (non-`'direct'`) hostStyle.
   * Old inspector builds will keep emitting nothing or `'direct'`;
   * the backend accepts both and normalizes with a
   * `legacy_direct_style` warn.
   */
  hostStyle?: "claude" | "chatgpt";
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
   * WebMCP-shaped MCPJam UI tools snapshot — per chat POST.
   *
   * Registered by the client catalog into the UI tools registry
   * (`client/src/lib/webmcp/ui-tools-registry.ts`) and snapshotted fresh at
   * POST time, exactly like `appTools`. The server defends the boundary in
   * `validateUiToolEntries` (caps, `ui_` name regex, schema size) and
   * registers them as no-execute AI SDK tools; `useChat.onToolCall` fulfills
   * them in-page.
   */
  uiTools?: UiToolSnapshotEntry[];
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
 * WebMCP-shaped MCPJam UI tool snapshot entry. Mirrors `UiToolEntry` in
 * `server/utils/chat-v2-orchestration.ts` so the client snapshotter and the
 * server validator share a single shape.
 *
 * Unlike app tools, UI tools are first-party and curated: `name` is the
 * model-facing tool name directly (reserved `ui_` prefix, validated at the
 * boundary), with no alias indirection. `readOnly` is metadata for policy
 * and native `annotations.readOnlyHint`, not an inclusion gate.
 */
export interface UiToolSnapshotEntry {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  readOnly: boolean;
}

export interface WidgetModelContextEntry {
  toolCallId: string;
  context: {
    content?: Record<string, unknown>[];
    structuredContent?: Record<string, unknown>;
  };
}
