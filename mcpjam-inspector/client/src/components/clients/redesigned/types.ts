import type { Edge, Node } from "@xyflow/react";
import type { HostConfigInputV2, HostStyleId } from "@/lib/client-config-v2";

/**
 * Identifiers for the focus-overlay tabs. Mirrors the header tab order in
 * the Harness design handoff (Agent → MCP Protocol → Apps Extension →
 * Servers → General).
 */
export type HostFocusTabId =
  | "behavior"
  | "protocol"
  | "apps"
  | "servers"
  | "appearance";

/** Where the user clicked to open the focus overlay. Drives return-focus. */
export type HostFocusOriginNodeId = string | null;

export type HostFocusState =
  | { open: false; tab: null; selectedServerId: null }
  | {
      open: true;
      tab: HostFocusTabId;
      selectedServerId: string | null;
      /**
       * Sandbox-config row to focus inside `AppsExtensionTab` when the
       * overlay opens from a `sandbox-cfg:<subKey>` matrix click. Currently
       * a no-op (the JSON editor exposes no programmatic key-focus API);
       * threaded through end-to-end so the future scroll-to-key landing is
       * a one-file change. See `AppsExtensionTab` focusSubKey TODO.
       */
      focusSubKey?: SandboxConfigSubKey;
    };

export interface HostAttentionIssue {
  level: "warning" | "error";
  tab: HostFocusTabId;
  field: string;
  message: string;
}

/** ============== Canvas node data types ============== */

/**
 * Dashed parent group that wraps every sub-node for a host. Sized
 * dynamically by the builder to fit the agent card + the protocol/apps
 * hub fan-outs, so the silhouette differs per host.
 */
export interface HostGroupNodeData extends Record<string, unknown> {
  kind: "host-group";
  hostName: string;
}

/**
 * Agent identity card. Stays as a single node — the agent's fields
 * (model, temperature, host style, tool approval, system prompt) form
 * a portrait, not a list, so atomizing them wouldn't add information.
 */
export interface AgentIdentityNodeData extends Record<string, unknown> {
  kind: "agent-identity";
  modelId: string;
  modelLabel: string;
  modelProvider: string | null;
  temperature: number;
  hostStyle: HostStyleId;
  hostStyleLabel: string;
  toolApproval: boolean;
  systemPromptEmpty: boolean;
  attentionFields: ReadonlyArray<string>;
  changedFields: ReadonlyArray<string>;
}

/**
 * Small puck node that anchors a section's fan-out (Protocol or Apps).
 * `kind` distinguishes the two so a single renderer can paint both with
 * the right icon/accent. `subtitle` is optional; currently used only on
 * the protocol hub when versions are pinned (e.g. "pinned 2026-01-26").
 */
export interface SectionHubNodeData extends Record<string, unknown> {
  kind: "section-hub";
  section: "protocol" | "apps";
  title: string;
  subtitle: string;
  /** Subtitle differs from the previous host — drives the morph flash. */
  subtitleChanged: boolean;
  hasAttention: boolean;
}

/**
 * One leaf per protocol slice that's actually overridden. Slices that
 * track SDK defaults stay collapsed into the hub. Stable `leafKey`
 * mirrors the validation field names so a click can deep-link the focus
 * panel to the right input.
 */
export type ProtocolLeafKey =
  | "clientInfo"
  | "protocolVersion"
  | "capabilities"
  | "hostContext"
  | "timeout"
  | "headers";

export interface ProtocolLeafNodeData extends Record<string, unknown> {
  kind: "protocol-leaf";
  leafKey: ProtocolLeafKey;
  label: string;
  value: string;
  isChanged: boolean;
  hasAttention: boolean;
}

/**
 * One leaf per Apps capability. Off capabilities still render — dimmed
 * and struck-through — because the *absence* of a cap is the most
 * informative thing about hosts like Cursor that don't advertise
 * `updateModelContext` or `message`.
 */
export type AppsCapLeafKey =
  | "openLinks"
  | "serverTools"
  | "serverResources"
  | "logging"
  | "updateModelContext"
  | "message";

export interface AppsCapLeafNodeData extends Record<string, unknown> {
  kind: "apps-cap-leaf";
  capKey: AppsCapLeafKey;
  label: string;
  on: boolean;
  /** Short qualifier shown as a tag: "text", "lc:false", etc. */
  qualifier: string | null;
  isChanged: boolean;
  /** Flipped from off → on on the last morph; renders the halo glow. */
  isNewlyOn: boolean;
}

/**
 * One row per sandbox config slice. The CSP-family rows (mode, restrictTo,
 * cspDirectives) plus permissions form the SEP-1865 surface; sandboxAttrs
 * and allowFeatures are inspector-only emission knobs that model what real
 * hosts emit at the browser layer.
 *
 * Severity drives the row tint:
 *   - `neutral`: default / empty / additive user grant, no surprise
 *   - `warn`: deviates from default but doesn't silently narrow (e.g.
 *     `mode: "relaxed"`)
 *   - `danger`: silently NARROWS what widgets can do, OR re-enables real
 *     script-execution loosening (e.g. `restrictTo` populated — the
 *     intersection trap that broke Excalidraw; `cspDirectives` carrying
 *     `'unsafe-eval'` / `'wasm-unsafe-eval'` / `'unsafe-inline'` /
 *     `'strict-dynamic'`)
 *
 * SEP-1865 is allowlist-only — there's no deny concept at any layer.
 */
export type SandboxConfigSubKey =
  | "mode"
  | "restrictTo"
  | "cspDirectives"
  | "permissions"
  | "sandboxAttrs"
  | "allowFeatures";

/**
 * CSP directive arrays surfaced under the `restrictTo` and `cspDirectives`
 * rows when populated. Two consumers, same shape:
 *
 * - `restrictTo` uses it for the four SEP-1865 allowlist directive families
 *   (`connectDomains` / `resourceDomains` / `frameDomains` / `baseUriDomains`).
 *   `domains` carries domain origins.
 * - `cspDirectives` uses it for arbitrary CSP directive names (`script-src`,
 *   `style-src`, …). `domains` carries source-expression tokens AND/OR
 *   public-domain origins — the field name is historical; semantically
 *   it's a flat token list.
 *
 * `key` is a free-form string so both consumers can share the type. Empty
 * arrays / undefined values are NOT rendered — the matrix only shows
 * directives the host actually populated.
 */
export interface CspDirectiveDetail {
  /** Directive family or name (e.g. "connectDomains", "script-src"). */
  key: string;
  /** Short display label. */
  label: string;
  /** Token entries declared under this directive (domains and/or source expressions). */
  domains: string[];
}

export interface SandboxConfigNodeData extends Record<string, unknown> {
  kind: "sandbox-config-leaf";
  subKey: SandboxConfigSubKey;
  label: string;
  /** Short value shown in the middle column (mode value or "N domains"). */
  summary: string;
  /** Right-column qualifier (e.g. per-directive breakdown `c:1 r:2 f:0 b:0`). */
  qualifier: string | null;
  severity: "neutral" | "warn" | "danger";
  isChanged: boolean;
  /**
   * Per-directive allowlist entries (currently only populated for the
   * `restrictTo` row when non-empty). Lets the matrix surface the actual
   * domains a host narrowed to, not just the count.
   */
  directives?: CspDirectiveDetail[];
}

/**
 * MCP client-capability row. Covers optional caps declared under
 * `initialize` (`roots` / `sampling` / `elicitation` / `tasks` /
 * `experimental`) plus `extensions` (`capabilities.extensions` in JSON).
 * Diff bits drive the matrix's "M" / "+" gutter so a host switch reads
 * the same way as the Apps cap matrix.
 */
export type ClientCapKey =
  | "roots"
  | "sampling"
  | "elicitation"
  | "tasks"
  | "experimental"
  | "extensions";

export interface ClientCapRow {
  key: ClientCapKey;
  on: boolean;
  /** Short, mono tags rendered on the right (e.g. "listChanged", "form", "url"). */
  subs: string[];
  isChanged: boolean;
  isNewlyOn: boolean;
}

/**
 * The host's entire surface, packed into one ReactFlow node. Replaces
 * the previous atomized layout (agent + protocol hub + protocol leaves
 * + apps hub + cap leaves). Servers stay as their
 * own subgraph so the hub→servers edges remain.
 */
export interface HostMatrixNodeData extends Record<string, unknown> {
  kind: "host-matrix";
  hostName: string;
  agent: AgentIdentityNodeData | null;
  protocolBand: ProtocolLeafNodeData[];
  clientCaps: ClientCapRow[];
  appsCaps: AppsCapLeafNodeData[];
  /**
   * Sandbox config rows (CSP mode, restrictTo, permissions). Always 3
   * rows when `appsExtensionAdvertised` is true — gated on the same flag
   * as `appsCaps` because sandbox is part of SEP-1865 and only meaningful
   * when the client opts in to the UI extension.
   */
  sandbox: SandboxConfigNodeData[];
  /**
   * hostInfo (name + version) the host will advertise in `ui/initialize`'s
   * `McpUiInitializeResult.hostInfo` per SEP-1865. Lifted from
   * `mcpProfile.apps.uiInitialize.hostInfo` so the matrix's View iframe
   * frame can show what a view would receive on connect. `null` when the
   * host hasn't customized it (the inspector falls back to its own
   * identity at runtime).
   */
  hostInfo: { name: string; version: string } | null;
  /**
   * Whether the client advertises `io.modelcontextprotocol/ui` in its
   * `clientCapabilities.extensions`. When false, the host-side Apps caps
   * (openLinks / serverTools / message / etc.) are inert — the client
   * can't render iframes regardless of what the host claims — so the
   * matrix hides the entire Apps section to avoid implying support.
   */
  appsExtensionAdvertised: boolean;
}

export interface ServersHubNodeData extends Record<string, unknown> {
  kind: "servers-hub";
  totalCount: number;
}

export interface ServerCardNodeData extends Record<string, unknown> {
  kind: "server-card";
  serverId: string;
  name: string;
  url: string | null;
  isOptional: boolean;
  insecure: boolean;
  hasOverride: boolean;
  /**
   * Runtime connection state surfaced from `appState.servers[name]`. Drives
   * the indicator dot so the host canvas matches the Connect/Servers tab
   * instead of unconditionally painting every server emerald. `unknown` is
   * used when the host builder has no runtime data (e.g. tests).
   */
  connectionStatus:
    | "connected"
    | "connecting"
    | "failed"
    | "disconnected"
    | "oauth-flow"
    | "unknown";
}

export interface AddServerPillNodeData extends Record<string, unknown> {
  kind: "add-server";
  label: string;
}

export type HostRedesignNodeData =
  | HostMatrixNodeData
  | ServersHubNodeData
  | ServerCardNodeData
  | AddServerPillNodeData;

export type HostRedesignNodeType =
  | "redesignHostMatrix"
  | "redesignServersHub"
  | "redesignServerCard"
  | "redesignAddServer";

export type HostRedesignFlowNode =
  | Node<HostMatrixNodeData, "redesignHostMatrix">
  | Node<ServersHubNodeData, "redesignServersHub">
  | Node<ServerCardNodeData, "redesignServerCard">
  | Node<AddServerPillNodeData, "redesignAddServer">;

export interface HostRedesignViewModel {
  hostName: string;
  nodes: HostRedesignFlowNode[];
  edges: Edge[];
  attention: ReadonlyArray<HostAttentionIssue>;
}

/** Snapshot id chip uses a stable short form `hc_xxxx` for display. */
export function shortenSnapshotId(id: string): string {
  if (!id) return "—";
  const tail = id.replace(/[^a-zA-Z0-9]/g, "").slice(-4) || id.slice(-4);
  return `hc_${tail.toLowerCase()}`;
}

/** Builder context shared by canvas/draft consumers. */
export interface HostRedesignContext {
  hostName: string;
  draft: HostConfigInputV2;
  savedSnapshotId: string;
  isDirty: boolean;
  projectServers: ReadonlyArray<{
    id: string;
    name: string;
    url?: string;
    connectionStatus?: ServerCardNodeData["connectionStatus"];
  }>;
  /**
   * Previous host's config + display name, captured by the builder view
   * on host switch. When present, the builder marks leaves/fields whose
   * value differs as `isChanged`, which drives the morph diff flash.
   * Undefined on first paint and during in-place edits.
   */
  prev?: {
    hostName: string;
    draft: HostConfigInputV2;
  };
}

/** Stable ids for the canvas-level nodes. */
export const HOST_MATRIX_NODE_ID = "host-matrix";
/** @deprecated alias retained for focusTabForNodeId — same id as the matrix. */
export const HOST_GROUP_NODE_ID = HOST_MATRIX_NODE_ID;
/**
 * Sub-region ids — these no longer correspond to discrete ReactFlow nodes
 * (the host renders as a single matrix node) but are still used by
 * `focusTabForNodeId` to route region clicks to the right focus tab.
 */
export const AGENT_IDENTITY_NODE_ID = "host-matrix:agent";
export const PROTOCOL_HUB_NODE_ID = "host-matrix:protocol";
export const APPS_HUB_NODE_ID = "host-matrix:apps";
export const SANDBOX_HUB_NODE_ID = "host-matrix:sandbox";
export const SERVERS_HUB_NODE_ID = "servers-hub";
export const ADD_SERVER_NODE_ID = "add-server";

/** Leaf id constructors — stable across hosts so RF can morph in place. */
export function protocolLeafNodeId(key: ProtocolLeafKey): string {
  return `protocol-leaf:${key}`;
}
export function appsCapLeafNodeId(key: AppsCapLeafKey): string {
  return `apps-cap:${key}`;
}
export function sandboxConfigLeafNodeId(key: SandboxConfigSubKey): string {
  return `sandbox-cfg:${key}`;
}

/**
 * Returns the focus tab a clicked node should open in the overlay.
 *
 * `focusSubKey` (optional) carries a sandbox-config row identifier when
 * the click came from a `sandbox-cfg:<subKey>` node. Consumers can use it
 * to scroll/highlight the matching JSON region inside `AppsExtensionTab`
 * once the editor exposes a programmatic key-focus API. Until then, it's
 * threaded through as-is and ignored by the editor — a deliberate no-op
 * (see `AppsExtensionTab`'s focusSubKey TODO).
 */
export function focusTabForNodeId(nodeId: string): {
  tab: HostFocusTabId;
  selectedServerId: string | null;
  focusSubKey?: SandboxConfigSubKey;
} | null {
  if (nodeId === HOST_GROUP_NODE_ID) {
    // After the General tab was removed, host-group clicks land on
    // Behavior — it's the most active settings tab and the natural
    // entry point for "I clicked the host bubble, show me settings".
    return { tab: "behavior", selectedServerId: null };
  }
  if (nodeId === AGENT_IDENTITY_NODE_ID) {
    return { tab: "behavior", selectedServerId: null };
  }
  // hostContext is a protocol-leaf-shaped node but lives under the
  // apps hub, so route it to the apps tab.
  if (nodeId === protocolLeafNodeId("hostContext")) {
    return { tab: "apps", selectedServerId: null };
  }
  if (
    nodeId === PROTOCOL_HUB_NODE_ID ||
    nodeId.startsWith("protocol-leaf:")
  ) {
    return { tab: "protocol", selectedServerId: null };
  }
  if (
    nodeId === APPS_HUB_NODE_ID ||
    nodeId.startsWith("apps-cap:") ||
    nodeId === SANDBOX_HUB_NODE_ID ||
    nodeId.startsWith("sandbox-cfg:")
  ) {
    // Sandbox routes to "apps" too — sandbox is mcpProfile.apps.sandbox in
    // the schema, edited via the same JSON document, so clicking a sandbox
    // row in the matrix opens the Apps Extension tab rather than a
    // dedicated tab. The matrix section is still visually distinct via the
    // severity tint; the editor stays unified.
    const focusSubKey = nodeId.startsWith("sandbox-cfg:")
      ? (nodeId.slice("sandbox-cfg:".length) as SandboxConfigSubKey)
      : undefined;
    return {
      tab: "apps",
      selectedServerId: null,
      ...(focusSubKey ? { focusSubKey } : {}),
    };
  }
  if (nodeId === SERVERS_HUB_NODE_ID) {
    return { tab: "servers", selectedServerId: null };
  }
  if (nodeId.startsWith("server-card:")) {
    return {
      tab: "servers",
      selectedServerId: nodeId.slice("server-card:".length),
    };
  }
  return null;
}
