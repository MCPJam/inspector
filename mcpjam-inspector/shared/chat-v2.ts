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
   * Host-level opt-in for progressive MCP tool discovery
   * (`search_mcp_tools` / `load_mcp_tools` meta-tools instead of sending
   * every tool definition every turn). Sourced from the project's default
   * HostConfigV2 toggle. `undefined` → use the backend's auto policy;
   * explicit `true`/`false` → force on/off for this request.
   */
  progressiveToolDiscovery?: boolean;
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
}
