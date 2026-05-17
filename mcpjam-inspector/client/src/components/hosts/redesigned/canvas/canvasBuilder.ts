import type { Edge } from "@xyflow/react";
import { getModelById } from "@/shared/types";
import { findHostStyle } from "@/lib/host-styles";
import {
  resolveEffectiveHostCapabilities,
  resolveClientInfo,
  resolveSupportedProtocolVersions,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import {
  ADD_SERVER_NODE_ID,
  HOST_MATRIX_NODE_ID,
  SERVERS_HUB_NODE_ID,
  type AgentIdentityNodeData,
  type AppsCapLeafKey,
  type AppsCapLeafNodeData,
  type ClientCapKey,
  type ClientCapRow,
  type HostAttentionIssue,
  type HostRedesignContext,
  type HostRedesignFlowNode,
  type HostRedesignViewModel,
  type ProtocolLeafKey,
  type ProtocolLeafNodeData,
  type SandboxConfigNodeData,
  type SandboxConfigSubKey,
} from "../types";
import { fieldsWithIssues } from "../focus/useHostDraftValidation";

/* ============================================================
   Layout constants. The host renders as a single matrix node;
   servers stay as their own subgraph below so the hub→server
   edges remain a recognizable signal.
   ============================================================ */
const MATRIX_W = 580;
// Matrix renders auto-height; these constants only feed the servers hub
// y-position downstream. Two heights so the servers hub doesn't float in
// a dead zone when the Apps Extension section is hidden (Codex et al).
//   - BASE: identity + stats + protocol + client-caps sub-matrix + footer
//   - APPS_SECTION: banner + head + 6 cap rows
const MATRIX_H_BASE = 400;
const MATRIX_H_APPS_SECTION = 240;
// Sandbox section: banner + head + 4 fixed rows (mode/restrictTo/deny/permissions)
const MATRIX_H_SANDBOX_SECTION = 160;
const SERVERS_HUB_GAP = 64;
const SERVERS_HUB_W_BASE = 220;
const SERVERS_HUB_W_PER_SERVER = 38;
const SERVERS_HUB_H = 48;
const SERVER_CARD_W = 220;
const SERVER_CARD_H = 88;
const SERVER_CARD_GAP_X = 16;
const SERVERS_ROW_GAP = 56;

/* ============================================================
   Stable cap orders. Keeping order stable lets row diffs morph
   in place when switching hosts.
   ============================================================ */
const APPS_CAP_ORDER: ReadonlyArray<{ key: AppsCapLeafKey; label: string }> = [
  { key: "openLinks", label: "openLinks" },
  { key: "serverTools", label: "serverTools" },
  { key: "serverResources", label: "serverResources" },
  { key: "logging", label: "logging" },
  { key: "updateModelContext", label: "updateModelContext" },
  { key: "message", label: "message" },
];

const CLIENT_CAP_ORDER: ReadonlyArray<ClientCapKey> = [
  "roots",
  "sampling",
  "elicitation",
  "tasks",
  "experimental",
];

/* ============================================================
   Protocol band descriptors. Request timeout is always emitted
   so it stays comparable across hosts. hostContext is part of
   the Apps Extension (SEP-1865) and is rendered as the matrix
   footer; everything else fills the protocol cells.
   ============================================================ */
interface ProtocolLeafDescriptor {
  key: ProtocolLeafKey;
  label: string;
  value: string;
}

function describeClientInfo(
  draft: HostConfigInputV2,
): ProtocolLeafDescriptor | null {
  const ci = resolveClientInfo(draft.mcpProfile);
  if (!ci) return null;
  const name = typeof ci.name === "string" ? ci.name : "(unnamed)";
  const version = typeof ci.version === "string" ? ci.version : "0.0.0";
  return { key: "clientInfo", label: "clientInfo", value: `${name} ${version}` };
}

function describeProtocolVersion(
  draft: HostConfigInputV2,
): ProtocolLeafDescriptor | null {
  const versions = resolveSupportedProtocolVersions(draft.mcpProfile);
  if (!versions || versions.length === 0) return null;
  const head = versions[0];
  const value = versions.length === 1 ? head : `${head} +${versions.length - 1}`;
  return { key: "protocolVersion", label: "protocol pin", value };
}

function describeBaseCapabilities(
  draft: HostConfigInputV2,
): ProtocolLeafDescriptor {
  // The five base-protocol caps already render in the Client-capabilities
  // sub-matrix below; this cell is dedicated to *which extensions* the host
  // advertises (the inner keys of `clientCapabilities.extensions`). Showing
  // top-level keys instead would hide the only piece of info this cell can
  // surface that the matrix below doesn't.
  const exts = draft.clientCapabilities?.extensions;
  const ids =
    exts && typeof exts === "object" && !Array.isArray(exts)
      ? Object.keys(exts as Record<string, unknown>)
      : [];
  let value: string;
  if (ids.length === 0) value = "(none)";
  else if (ids.length === 1) value = ids[0];
  else value = `${ids[0]} +${ids.length - 1}`;
  return { key: "capabilities", label: "extensions", value };
}

function describeHostContext(
  draft: HostConfigInputV2,
): ProtocolLeafDescriptor {
  const count = Object.keys(draft.hostContext ?? {}).length;
  return {
    key: "hostContext",
    label: "hostContext",
    value: `{ ${count} ${count === 1 ? "field" : "fields"} }`,
  };
}

function describeTimeout(draft: HostConfigInputV2): ProtocolLeafDescriptor {
  const secs = Math.round(draft.connectionDefaults.requestTimeout / 1000);
  return {
    key: "timeout",
    label: "request timeout",
    value: `${secs}s`,
  };
}

function describeHeaders(
  draft: HostConfigInputV2,
): ProtocolLeafDescriptor | null {
  const count = Object.keys(draft.connectionDefaults.headers ?? {}).length;
  if (count === 0) return null;
  return {
    key: "headers",
    label: "default headers",
    value: `${count} set`,
  };
}

function buildProtocolBand(
  draft: HostConfigInputV2,
): ProtocolLeafDescriptor[] {
  // capabilities + timeout are always emitted (stable slots); optional
  // descriptors pack after them so position diffability is preserved.
  return [
    describeBaseCapabilities(draft),
    describeTimeout(draft),
    describeClientInfo(draft),
    describeProtocolVersion(draft),
    describeHeaders(draft),
  ].filter((l): l is ProtocolLeafDescriptor => l !== null);
}

interface AppsCapDescriptor {
  key: AppsCapLeafKey;
  label: string;
  on: boolean;
  qualifier: string | null;
}

function buildAppsCaps(draft: HostConfigInputV2): AppsCapDescriptor[] {
  const blob = resolveEffectiveHostCapabilities({
    hostStyle: draft.hostStyle,
    hostCapabilitiesOverride: draft.hostCapabilitiesOverride,
  }) as Record<string, unknown>;

  return APPS_CAP_ORDER.map(({ key, label }) => {
    const value = blob[key];
    const on = value !== undefined && value !== null;
    let qualifier: string | null = null;
    if (on && typeof value === "object" && !Array.isArray(value)) {
      const v = value as Record<string, unknown>;
      if (v.listChanged === false) qualifier = "lc:false";
      else if (v.text !== undefined) qualifier = "text";
    }
    return { key, label, on, qualifier };
  });
}

/* ============================================================
   Sandbox config rows. The sandbox slice
   (mcpProfile.apps.sandbox) decides whether widget CSP
   declarations are honored, narrowed, or overridden — a hardcoded
   `restrictTo` here was silently dropping every widget-declared
   domain that wasn't in our 3-item allowlist (intersection went to
   empty → connect-src 'none', all fetches blocked). The matrix
   surfaces these four slices so "why isn't my widget working?"
   stops being invisible state.

   Severity contract (drives row tint in HostMatrixCard):
     - `danger`: silently NARROWS what widgets can do (restrictTo
       populated — the intersection trap).
     - `warn`: deviates from default but doesn't silently narrow
       (mode "relaxed", deny populated).
     - `neutral`: default or empty.
   ============================================================ */
interface SandboxConfigDescriptor {
  subKey: SandboxConfigSubKey;
  label: string;
  summary: string;
  qualifier: string | null;
  severity: "neutral" | "warn" | "danger";
}

function countDirectives(
  set:
    | {
        connectDomains?: string[];
        resourceDomains?: string[];
        frameDomains?: string[];
        baseUriDomains?: string[];
      }
    | undefined,
): { total: number; breakdown: string } {
  const c = set?.connectDomains?.length ?? 0;
  const r = set?.resourceDomains?.length ?? 0;
  const f = set?.frameDomains?.length ?? 0;
  const b = set?.baseUriDomains?.length ?? 0;
  return {
    total: c + r + f + b,
    breakdown: `c:${c} r:${r} f:${f} b:${b}`,
  };
}

function buildSandboxConfig(
  draft: HostConfigInputV2,
): SandboxConfigDescriptor[] {
  const sandbox = draft.mcpProfile?.apps?.sandbox;
  const csp = sandbox?.csp;
  const perms = sandbox?.permissions;

  // mode — default per resolver is "declared". Surface that explicitly
  // when undefined so users see what's actually applied at runtime.
  const mode = csp?.mode ?? "declared";
  const modeDescriptor: SandboxConfigDescriptor = {
    subKey: "mode",
    label: "mode",
    summary: mode,
    qualifier: csp?.mode === undefined ? "default" : null,
    // "relaxed" opens the iframe up — not silent narrowing, but worth a
    // tint so users notice they're not getting host-default protection.
    severity: mode === "relaxed" ? "warn" : "neutral",
  };

  const restrict = countDirectives(csp?.restrictTo);
  const restrictDescriptor: SandboxConfigDescriptor = {
    subKey: "restrictTo",
    label: "restrictTo",
    summary: restrict.total === 0 ? "—" : `${restrict.total} domains`,
    qualifier: restrict.total === 0 ? null : restrict.breakdown,
    // restrictTo is the intersection trap — any non-zero count means
    // widget-declared domains outside this set get silently dropped.
    severity: restrict.total === 0 ? "neutral" : "danger",
  };

  const deny = countDirectives(csp?.deny);
  const denyDescriptor: SandboxConfigDescriptor = {
    subKey: "deny",
    label: "deny",
    summary: deny.total === 0 ? "—" : `${deny.total} domains`,
    qualifier: deny.total === 0 ? null : deny.breakdown,
    // deny does narrow, but explicitly — the user opted in. Warn rather
    // than danger so danger stays reserved for the silent restrictTo trap.
    severity: deny.total === 0 ? "neutral" : "warn",
  };

  const permsMode = perms?.mode ?? "resource-declared";
  const granted: string[] = [];
  if (perms?.allow) {
    for (const [name, on] of Object.entries(perms.allow)) {
      if (on) granted.push(name);
    }
  }
  const permsDescriptor: SandboxConfigDescriptor = {
    subKey: "permissions",
    label: "permissions",
    summary: permsMode,
    qualifier: granted.length === 0 ? null : granted.join(", "),
    // "deny-all" is a tightening, not loosening — neutral. Anything that
    // grants beyond default ("custom" with allow entries) we still leave
    // neutral; permissions are explicit user grants, not silent traps.
    severity: "neutral",
  };

  return [modeDescriptor, restrictDescriptor, denyDescriptor, permsDescriptor];
}

/* ============================================================
   Client (base-protocol) capability detection. Mirrors the
   2025-11-25 initialize handshake shape — roots / sampling /
   elicitation / tasks / experimental.
   ============================================================ */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describeClientCap(
  key: ClientCapKey,
  blob: Record<string, unknown>,
): { on: boolean; subs: string[] } {
  const v = blob[key];
  if (v === undefined || v === null) return { on: false, subs: [] };
  if (!isRecord(v)) return { on: true, subs: [] };
  const subs: string[] = [];
  if (key === "roots") {
    if (v.listChanged === true) subs.push("listChanged");
  } else if (key === "elicitation") {
    if (isRecord(v.form)) subs.push("form");
    if (isRecord(v.url)) subs.push("url");
  } else if (key === "tasks") {
    const req = isRecord(v.requests) ? v.requests : null;
    if (req && isRecord(req.elicitation) && isRecord(req.elicitation.create))
      subs.push("elicit·create");
    if (req && isRecord(req.sampling) && isRecord(req.sampling.createMessage))
      subs.push("sample·createMsg");
  }
  return { on: true, subs };
}

function buildClientCaps(
  draft: HostConfigInputV2,
  prev: HostConfigInputV2 | undefined,
): ClientCapRow[] {
  const blob = draft.clientCapabilities ?? {};
  const prevBlob = prev?.clientCapabilities ?? null;
  return CLIENT_CAP_ORDER.map((key) => {
    const { on, subs } = describeClientCap(key, blob);
    const prevDesc = prevBlob ? describeClientCap(key, prevBlob) : null;
    const isChanged =
      prevDesc !== null &&
      (prevDesc.on !== on || prevDesc.subs.join("|") !== subs.join("|"));
    const isNewlyOn = prevDesc !== null && !prevDesc.on && on;
    return { key, on, subs, isChanged, isNewlyOn };
  });
}

/* ============================================================
   Diff helpers — return the same shape the renderers expect on
   the individual data fields (isChanged / isNewlyOn / etc.).
   ============================================================ */
function agentChangedFields(
  draft: HostConfigInputV2,
  prev: HostConfigInputV2 | undefined,
): string[] {
  if (!prev) return [];
  const changed: string[] = [];
  if (prev.modelId !== draft.modelId) changed.push("modelId");
  if (prev.temperature !== draft.temperature) changed.push("temperature");
  if (prev.hostStyle !== draft.hostStyle) changed.push("hostStyle");
  if (prev.requireToolApproval !== draft.requireToolApproval)
    changed.push("toolApproval");
  if (prev.systemPrompt.trim() !== draft.systemPrompt.trim())
    changed.push("systemPrompt");
  return changed;
}

/* ============================================================
   Builder. Emits ONE matrix node packing the entire host surface
   plus the servers subgraph as siblings.
   ============================================================ */
export function buildRedesignedHostCanvas(
  context: HostRedesignContext,
  attention: ReadonlyArray<HostAttentionIssue>,
): HostRedesignViewModel {
  const { draft, hostName, prev } = context;
  const prevDraft = prev?.draft;

  const behaviorAttention = fieldsWithIssues(attention, "behavior");

  const modelDef = draft.modelId ? getModelById(draft.modelId) : null;
  const styleDef = findHostStyle(draft.hostStyle);

  // ---- Agent identity (single object, matches AgentIdentityNodeData) ----
  const agent: AgentIdentityNodeData = {
    kind: "agent-identity",
    modelId: draft.modelId,
    modelLabel: modelDef?.name ?? draft.modelId ?? "No model selected",
    modelProvider: modelDef?.provider ?? null,
    temperature: draft.temperature,
    hostStyle: draft.hostStyle,
    hostStyleLabel: styleDef?.chatUi.label ?? draft.hostStyle,
    toolApproval: draft.requireToolApproval,
    systemPromptEmpty: draft.systemPrompt.trim() === "",
    attentionFields: Array.from(behaviorAttention),
    changedFields: agentChangedFields(draft, prevDraft),
  };

  // ---- Protocol band ----
  const protocolDescs = buildProtocolBand(draft);
  const prevProtocolByKey: Record<string, ProtocolLeafDescriptor> = {};
  if (prevDraft) {
    for (const l of buildProtocolBand(prevDraft)) prevProtocolByKey[l.key] = l;
  }
  const protocolBand: ProtocolLeafNodeData[] = protocolDescs.map((leaf) => {
    const prevLeaf = prevProtocolByKey[leaf.key];
    return {
      kind: "protocol-leaf",
      leafKey: leaf.key,
      label: leaf.label,
      value: leaf.value,
      isChanged: prevLeaf !== undefined && prevLeaf.value !== leaf.value,
      hasAttention: false,
    };
  });

  // ---- Apps caps ----
  const appsDescs = buildAppsCaps(draft);
  const prevAppsByKey: Record<string, AppsCapDescriptor> = {};
  if (prevDraft) {
    for (const l of buildAppsCaps(prevDraft)) prevAppsByKey[l.key] = l;
  }
  const appsCaps: AppsCapLeafNodeData[] = appsDescs.map((leaf) => {
    const prevLeaf = prevAppsByKey[leaf.key];
    const onChanged =
      prevLeaf !== undefined &&
      (prevLeaf.on !== leaf.on || prevLeaf.qualifier !== leaf.qualifier);
    const newlyOn = prevLeaf !== undefined && !prevLeaf.on && leaf.on;
    return {
      kind: "apps-cap-leaf",
      capKey: leaf.key,
      label: leaf.label,
      on: leaf.on,
      qualifier: leaf.qualifier,
      isChanged: onChanged,
      isNewlyOn: newlyOn,
    };
  });

  // ---- Sandbox config rows ----
  const sandboxDescs = buildSandboxConfig(draft);
  const prevSandboxByKey: Record<SandboxConfigSubKey, SandboxConfigDescriptor> =
    {} as Record<SandboxConfigSubKey, SandboxConfigDescriptor>;
  if (prevDraft) {
    for (const l of buildSandboxConfig(prevDraft)) prevSandboxByKey[l.subKey] = l;
  }
  const sandbox: SandboxConfigNodeData[] = sandboxDescs.map((leaf) => {
    const prevLeaf = prevDraft ? prevSandboxByKey[leaf.subKey] : undefined;
    const isChanged =
      prevLeaf !== undefined &&
      (prevLeaf.summary !== leaf.summary ||
        prevLeaf.qualifier !== leaf.qualifier);
    return {
      kind: "sandbox-config-leaf",
      subKey: leaf.subKey,
      label: leaf.label,
      summary: leaf.summary,
      qualifier: leaf.qualifier,
      severity: leaf.severity,
      isChanged,
    };
  });

  // ---- hostContext (footer) ----
  const hostContextDesc = describeHostContext(draft);
  const prevHostContext = prevDraft ? describeHostContext(prevDraft) : null;
  const hostContext: ProtocolLeafNodeData = {
    kind: "protocol-leaf",
    leafKey: "hostContext",
    label: hostContextDesc.label,
    value: hostContextDesc.value,
    isChanged:
      prevHostContext !== null && prevHostContext.value !== hostContextDesc.value,
    hasAttention: false,
  };

  // ---- Client (base-protocol) caps ----
  const clientCaps = buildClientCaps(draft, prevDraft);

  // Whether the client advertises the MCP UI extension. Host-side Apps
  // capabilities only matter when the client opts in to rendering iframes;
  // a CLI like codex-mcp-client publishes neither the extension nor any
  // UI ext block, so the matrix should hide the Apps section entirely.
  const appsExtensionAdvertised = (() => {
    const exts = draft.clientCapabilities?.extensions;
    if (!isRecord(exts)) return false;
    return isRecord(exts["io.modelcontextprotocol/ui"]);
  })();

  // ---- Nodes / edges ----
  const nodes: HostRedesignFlowNode[] = [];
  const edges: Edge[] = [];

  // 1) Matrix node — the entire host surface in one ReactFlow node.
  nodes.push({
    id: HOST_MATRIX_NODE_ID,
    type: "redesignHostMatrix",
    position: { x: 0, y: 0 },
    style: { width: MATRIX_W },
    data: {
      kind: "host-matrix",
      hostName: hostName.trim() || "Untitled host",
      agent,
      protocolBand,
      clientCaps,
      appsCaps,
      sandbox,
      appsExtensionAdvertised,
      hostContext,
    },
    draggable: false,
    selectable: false,
  });

  // 2) Servers hub — sibling, below the matrix. Y tracks whether the
  // Apps section actually renders so there's no dead zone between the
  // footer and the hub when the section is hidden.
  const matrixH =
    MATRIX_H_BASE +
    (appsExtensionAdvertised
      ? MATRIX_H_APPS_SECTION + MATRIX_H_SANDBOX_SECTION
      : 0);
  const serversHubY = matrixH + SERVERS_HUB_GAP;
  const totalServers = context.projectServers.length;
  const serversHubW = Math.max(
    SERVERS_HUB_W_BASE,
    180 + totalServers * SERVERS_HUB_W_PER_SERVER,
  );
  const serversHubX = (MATRIX_W - serversHubW) / 2;
  nodes.push({
    id: SERVERS_HUB_NODE_ID,
    type: "redesignServersHub",
    position: { x: serversHubX, y: serversHubY },
    style: { width: serversHubW, height: SERVERS_HUB_H },
    data: { kind: "servers-hub", totalCount: totalServers },
    draggable: false,
  });

  edges.push({
    id: "host-matrix-to-hub",
    source: HOST_MATRIX_NODE_ID,
    target: SERVERS_HUB_NODE_ID,
    type: "default",
    style: { stroke: "oklch(0.68 0.11 40 / 0.55)", strokeWidth: 1.5 },
  });

  // 3) Server cards — required first, then optional. Insecure http
  //    URLs render an amber stroke regardless of required/optional.
  const requiredSet = new Set(draft.serverIds);
  const orderedServerIds: string[] = [];
  for (const server of context.projectServers) {
    if (requiredSet.has(server.id)) orderedServerIds.push(server.id);
  }
  for (const server of context.projectServers) {
    if (!requiredSet.has(server.id)) orderedServerIds.push(server.id);
  }

  const totalCardsW =
    orderedServerIds.length === 0
      ? 0
      : orderedServerIds.length * SERVER_CARD_W +
        (orderedServerIds.length - 1) * SERVER_CARD_GAP_X;
  const cardsStartX = (MATRIX_W - totalCardsW) / 2;
  const serverRowY = serversHubY + SERVERS_HUB_H + SERVERS_ROW_GAP;

  orderedServerIds.forEach((serverId, i) => {
    const server = context.projectServers.find((s) => s.id === serverId);
    const url = server?.url ?? null;
    const insecure = !!url && url.startsWith("http://");
    const isOptional = !requiredSet.has(serverId);
    const override = draft.serverConnectionOverrides?.[serverId];
    const hasOverride =
      !!override &&
      ((!!override.headersOverride &&
        Object.keys(override.headersOverride).length > 0) ||
        override.requestTimeoutOverride !== undefined);

    nodes.push({
      id: `server-card:${serverId}`,
      type: "redesignServerCard",
      position: {
        x: cardsStartX + i * (SERVER_CARD_W + SERVER_CARD_GAP_X),
        y: serverRowY,
      },
      style: { width: SERVER_CARD_W, height: SERVER_CARD_H },
      data: {
        kind: "server-card",
        serverId,
        name: server?.name ?? "Server",
        url,
        isOptional,
        insecure,
        hasOverride: !!hasOverride,
        connectionStatus: server?.connectionStatus ?? "unknown",
      },
      draggable: false,
    });

    edges.push({
      id: `hub-to-server-${serverId}`,
      source: SERVERS_HUB_NODE_ID,
      target: `server-card:${serverId}`,
      type: "default",
      style: {
        stroke: insecure
          ? "oklch(0.65 0.18 60)"
          : "oklch(0.68 0.11 40 / 0.55)",
        strokeWidth: 1.5,
        strokeDasharray: isOptional ? "4 4" : undefined,
      },
    });
  });

  // 4) Add-server pill.
  const addServerX =
    orderedServerIds.length === 0
      ? serversHubX + (serversHubW - 36) / 2
      : cardsStartX +
        orderedServerIds.length * (SERVER_CARD_W + SERVER_CARD_GAP_X);
  nodes.push({
    id: ADD_SERVER_NODE_ID,
    type: "redesignAddServer",
    position: {
      x: addServerX,
      y: serverRowY + (SERVER_CARD_H - 36) / 2,
    },
    data: { kind: "add-server", label: "Add server" },
    draggable: false,
    selectable: false,
  });

  return {
    hostName: hostName.trim() || "Untitled host",
    nodes,
    edges,
    attention,
  };
}
