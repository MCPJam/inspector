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
  AGENT_IDENTITY_NODE_ID,
  APPS_HUB_NODE_ID,
  HOST_GROUP_NODE_ID,
  PROTOCOL_HUB_NODE_ID,
  SERVERS_HUB_NODE_ID,
  appsCapLeafNodeId,
  protocolLeafNodeId,
  type AppsCapLeafKey,
  type HostAttentionIssue,
  type HostRedesignContext,
  type HostRedesignFlowNode,
  type HostRedesignViewModel,
  type ProtocolLeafKey,
} from "../types";
import { fieldsWithIssues } from "../focus/useHostDraftValidation";

/* ============================================================
   Layout constants. The host group's size is now derived from
   how many leaves each section emits, so per-host silhouette
   varies — that's the whole point of atomization. Numbers match
   the mock (host-viz-morph.html) so design and code stay in sync.
   ============================================================ */
const AGENT_W = 248;
const AGENT_H = 252;
const HUB_W = 188;
const HUB_H = 52;
const LEAF_W = 158;
const LEAF_H = 42;
const LEAF_GAP_X = 12;
const LEAF_ROW_H = 50;
const LEAF_COLS = 2;
const HUB_TO_LEAF_GAP = 38;
const AGENT_TO_HUB_GAP = 32;
const SECTION_INNER_GAP = 28;
const GROUP_PAD = 22;
const GROUP_PAD_TOP = 56;

const RIGHT_COL_W =
  HUB_W + HUB_TO_LEAF_GAP + LEAF_COLS * LEAF_W + (LEAF_COLS - 1) * LEAF_GAP_X;
const GROUP_W = GROUP_PAD * 2 + AGENT_W + AGENT_TO_HUB_GAP + RIGHT_COL_W;

const SERVERS_HUB_GAP = 64;
const SERVERS_HUB_W_BASE = 220;
const SERVERS_HUB_W_PER_SERVER = 38;
const SERVERS_HUB_H = 48;
const SERVER_CARD_W = 220;
const SERVER_CARD_H = 88;
const SERVER_CARD_GAP_X = 16;
const SERVERS_ROW_GAP = 56;

/* ============================================================
   Stable cap order. Cursor's probe-derived list is the smallest;
   keeping the order stable lets leaves morph in place rather
   than rebuild when switching hosts.
   ============================================================ */
const APPS_CAP_ORDER: ReadonlyArray<{ key: AppsCapLeafKey; label: string }> = [
  { key: "openLinks", label: "openLinks" },
  { key: "serverTools", label: "serverTools" },
  { key: "serverResources", label: "serverResources" },
  { key: "logging", label: "logging" },
  { key: "updateModelContext", label: "updateModelContext" },
  { key: "message", label: "message" },
];

/* ============================================================
   Protocol leaf descriptors — one per slice that's overridden
   away from SDK defaults. Request timeout is always emitted so
   it stays comparable across hosts. hostContext belongs to the
   Apps Extension (SEP-1865) and is rendered under the apps hub.
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
): ProtocolLeafDescriptor | null {
  const caps = draft.clientCapabilities ?? {};
  const present: string[] = [];
  if (caps.roots) present.push("roots");
  if (caps.sampling) present.push("sampling");
  if (caps.experimental) present.push("experimental");
  if (present.length === 0) return null;
  return {
    key: "capabilities",
    label: "capabilities",
    value: present.join(" · "),
  };
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

function buildProtocolLeaves(
  draft: HostConfigInputV2,
): ProtocolLeafDescriptor[] {
  const leaves: (ProtocolLeafDescriptor | null)[] = [
    describeClientInfo(draft),
    describeProtocolVersion(draft),
    describeBaseCapabilities(draft),
    describeTimeout(draft),
    describeHeaders(draft),
  ];
  return leaves.filter((l): l is ProtocolLeafDescriptor => l !== null);
}

interface AppsCapLeafDescriptor {
  key: AppsCapLeafKey;
  label: string;
  on: boolean;
  qualifier: string | null;
}

function buildAppsCapLeaves(
  draft: HostConfigInputV2,
): AppsCapLeafDescriptor[] {
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
      // `listChanged: false` is the load-bearing signal from Cursor's
      // probe; `text: {}` is the load-bearing signal for Claude/ChatGPT
      // (vs. arbitrary structured content).
      if (v.listChanged === false) qualifier = "lc:false";
      else if (v.text !== undefined) qualifier = "text";
    }
    return { key, label, on, qualifier };
  });
}

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

function protocolSubtitle(draft: HostConfigInputV2): string {
  const versions = resolveSupportedProtocolVersions(draft.mcpProfile);
  return versions && versions.length > 0
    ? `pinned ${versions[0]}`
    : "SDK defaults";
}

function appsSubtitle(draft: HostConfigInputV2): string {
  const mode = draft.mcpProfile?.apps?.sandbox?.csp?.mode ?? "host-default";
  const ctxCount = Object.keys(draft.hostContext ?? {}).length;
  return `sandbox: ${mode} · ${ctxCount} ctx ${ctxCount === 1 ? "field" : "fields"}`;
}

/* ============================================================
   Builder. Emits the host-group with all children + the servers
   subgraph as siblings. Leaves are children of the group so the
   dashed border wraps the whole network and resizes with it.
   ============================================================ */
export function buildRedesignedHostCanvas(
  context: HostRedesignContext,
  attention: ReadonlyArray<HostAttentionIssue>,
): HostRedesignViewModel {
  const { draft, hostName, prev } = context;
  const prevDraft = prev?.draft;

  const behaviorAttention = fieldsWithIssues(attention, "behavior");
  const protocolAttention = fieldsWithIssues(attention, "protocol");
  const appsAttention = fieldsWithIssues(attention, "apps");

  const modelDef = draft.modelId ? getModelById(draft.modelId) : null;
  const styleDef = findHostStyle(draft.hostStyle);

  const protocolLeaves = buildProtocolLeaves(draft);
  const appsCapLeaves = buildAppsCapLeaves(draft);
  const hostContextLeaf = describeHostContext(draft);

  // Section heights track leaf-row counts; the group then sizes to
  // fit. This is the geometric signal that makes a Cursor host look
  // smaller than a Claude host without the user reading a single value.
  // The apps grid leads with the hostContext value leaf, then the cap
  // leaves — so add 1 to the count.
  const protocolRows = Math.max(1, Math.ceil(protocolLeaves.length / LEAF_COLS));
  const appsLeafCount = 1 + appsCapLeaves.length;
  const appsRows = Math.max(1, Math.ceil(appsLeafCount / LEAF_COLS));
  const protocolSectionH = Math.max(HUB_H, protocolRows * LEAF_ROW_H);
  const appsSectionH = Math.max(HUB_H, appsRows * LEAF_ROW_H);
  const rightColH = protocolSectionH + SECTION_INNER_GAP + appsSectionH;
  const innerH = Math.max(AGENT_H, rightColH);
  const groupH = GROUP_PAD_TOP + innerH + GROUP_PAD;

  // Y-center the shorter column inside the inner content area so the
  // visual mass balances. The taller column anchors the height.
  const rightColTopY = GROUP_PAD_TOP + (innerH - rightColH) / 2;
  const agentY = GROUP_PAD_TOP + (innerH - AGENT_H) / 2;

  const agentX = GROUP_PAD;
  const hubX = GROUP_PAD + AGENT_W + AGENT_TO_HUB_GAP;
  const protocolHubY = rightColTopY + (protocolSectionH - HUB_H) / 2;
  const appsHubY =
    rightColTopY +
    protocolSectionH +
    SECTION_INNER_GAP +
    (appsSectionH - HUB_H) / 2;

  const nodes: HostRedesignFlowNode[] = [];
  const edges: Edge[] = [];

  // 1) Dashed parent group, sized to fit.
  nodes.push({
    id: HOST_GROUP_NODE_ID,
    type: "redesignHostGroup",
    position: { x: 0, y: 0 },
    style: { width: GROUP_W, height: groupH },
    data: {
      kind: "host-group",
      hostName: hostName.trim() || "Untitled host",
    },
    draggable: false,
    selectable: false,
  });

  // 2) Agent identity card — left column, vertically centered.
  nodes.push({
    id: AGENT_IDENTITY_NODE_ID,
    type: "redesignAgentIdentity",
    parentId: HOST_GROUP_NODE_ID,
    extent: "parent",
    position: { x: agentX, y: agentY },
    style: { width: AGENT_W },
    data: {
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
    },
    draggable: false,
  });

  // 3) Protocol hub + leaves.
  const protocolSubtitleNext = protocolSubtitle(draft);
  const protocolSubtitlePrev = prevDraft
    ? protocolSubtitle(prevDraft)
    : protocolSubtitleNext;
  nodes.push({
    id: PROTOCOL_HUB_NODE_ID,
    type: "redesignSectionHub",
    parentId: HOST_GROUP_NODE_ID,
    extent: "parent",
    position: { x: hubX, y: protocolHubY },
    style: { width: HUB_W, height: HUB_H },
    data: {
      kind: "section-hub",
      section: "protocol",
      title: "MCP Protocol",
      subtitle: protocolSubtitleNext,
      subtitleChanged: protocolSubtitleNext !== protocolSubtitlePrev,
      hasAttention: protocolAttention.size > 0,
    },
    draggable: false,
  });

  const prevProtocolByKey: Record<string, ProtocolLeafDescriptor> = {};
  if (prevDraft) {
    for (const l of buildProtocolLeaves(prevDraft)) {
      prevProtocolByKey[l.key] = l;
    }
  }
  const protocolGridTop =
    protocolHubY + HUB_H / 2 - (protocolRows * LEAF_ROW_H) / 2;
  protocolLeaves.forEach((leaf, i) => {
    const col = i % LEAF_COLS;
    const row = Math.floor(i / LEAF_COLS);
    const leafX = hubX + HUB_W + HUB_TO_LEAF_GAP + col * (LEAF_W + LEAF_GAP_X);
    const leafY =
      protocolGridTop + row * LEAF_ROW_H + (LEAF_ROW_H - LEAF_H) / 2;
    const prevLeaf = prevProtocolByKey[leaf.key];
    nodes.push({
      id: protocolLeafNodeId(leaf.key),
      type: "redesignProtocolLeaf",
      parentId: HOST_GROUP_NODE_ID,
      extent: "parent",
      position: { x: leafX, y: leafY },
      style: { width: LEAF_W, height: LEAF_H },
      data: {
        kind: "protocol-leaf",
        leafKey: leaf.key,
        label: leaf.label,
        value: leaf.value,
        // No prev → first paint or no host switch yet; don't flash.
        // Existing-but-different prev → flash on morph.
        isChanged: prevLeaf !== undefined && prevLeaf.value !== leaf.value,
        hasAttention: protocolAttention.has(leaf.key),
      },
      draggable: false,
    });
    edges.push({
      id: `protocol-hub-to-${leaf.key}`,
      source: PROTOCOL_HUB_NODE_ID,
      target: protocolLeafNodeId(leaf.key),
      type: "default",
      style: {
        stroke: "oklch(0.68 0.11 40 / 0.45)",
        strokeWidth: 1,
      },
    });
  });

  // 4) Apps hub + cap leaves.
  const appsSubtitleNext = appsSubtitle(draft);
  const appsSubtitlePrev = prevDraft
    ? appsSubtitle(prevDraft)
    : appsSubtitleNext;
  nodes.push({
    id: APPS_HUB_NODE_ID,
    type: "redesignSectionHub",
    parentId: HOST_GROUP_NODE_ID,
    extent: "parent",
    position: { x: hubX, y: appsHubY },
    style: { width: HUB_W, height: HUB_H },
    data: {
      kind: "section-hub",
      section: "apps",
      title: "Apps Extension",
      subtitle: appsSubtitleNext,
      subtitleChanged: appsSubtitleNext !== appsSubtitlePrev,
      hasAttention: appsAttention.size > 0,
    },
    draggable: false,
  });

  const prevAppsByKey: Record<string, AppsCapLeafDescriptor> = {};
  if (prevDraft) {
    for (const l of buildAppsCapLeaves(prevDraft)) prevAppsByKey[l.key] = l;
  }
  const appsGridTop = appsHubY + HUB_H / 2 - (appsRows * LEAF_ROW_H) / 2;

  // 4a) hostContext value leaf — leads the apps grid. Same renderer as
  // a protocol leaf (label + value), but parented under the apps hub
  // because hostContext is part of the Apps Extension (SEP-1865).
  {
    const leafX = hubX + HUB_W + HUB_TO_LEAF_GAP;
    const leafY = appsGridTop + (LEAF_ROW_H - LEAF_H) / 2;
    const prevLeaf = prevDraft ? describeHostContext(prevDraft) : undefined;
    nodes.push({
      id: protocolLeafNodeId(hostContextLeaf.key),
      type: "redesignProtocolLeaf",
      parentId: HOST_GROUP_NODE_ID,
      extent: "parent",
      position: { x: leafX, y: leafY },
      style: { width: LEAF_W, height: LEAF_H },
      data: {
        kind: "protocol-leaf",
        leafKey: hostContextLeaf.key,
        label: hostContextLeaf.label,
        value: hostContextLeaf.value,
        isChanged:
          prevLeaf !== undefined && prevLeaf.value !== hostContextLeaf.value,
        hasAttention: appsAttention.has(hostContextLeaf.key),
      },
      draggable: false,
    });
    edges.push({
      id: `apps-hub-to-${hostContextLeaf.key}`,
      source: APPS_HUB_NODE_ID,
      target: protocolLeafNodeId(hostContextLeaf.key),
      type: "default",
      style: {
        stroke: "oklch(0.68 0.11 40 / 0.45)",
        strokeWidth: 1,
      },
    });
  }

  appsCapLeaves.forEach((leaf, idx) => {
    // hostContext occupies slot 0; cap leaves start at slot 1.
    const i = idx + 1;
    const col = i % LEAF_COLS;
    const row = Math.floor(i / LEAF_COLS);
    const leafX = hubX + HUB_W + HUB_TO_LEAF_GAP + col * (LEAF_W + LEAF_GAP_X);
    const leafY = appsGridTop + row * LEAF_ROW_H + (LEAF_ROW_H - LEAF_H) / 2;
    const prevLeaf = prevAppsByKey[leaf.key];
    const onChanged =
      prevLeaf !== undefined &&
      (prevLeaf.on !== leaf.on || prevLeaf.qualifier !== leaf.qualifier);
    const newlyOn = prevLeaf !== undefined && !prevLeaf.on && leaf.on;
    nodes.push({
      id: appsCapLeafNodeId(leaf.key),
      type: "redesignAppsCapLeaf",
      parentId: HOST_GROUP_NODE_ID,
      extent: "parent",
      position: { x: leafX, y: leafY },
      style: { width: LEAF_W, height: LEAF_H },
      data: {
        kind: "apps-cap-leaf",
        capKey: leaf.key,
        label: leaf.label,
        on: leaf.on,
        qualifier: leaf.qualifier,
        isChanged: onChanged,
        isNewlyOn: newlyOn,
      },
      draggable: false,
    });
    edges.push({
      id: `apps-hub-to-${leaf.key}`,
      source: APPS_HUB_NODE_ID,
      target: appsCapLeafNodeId(leaf.key),
      type: "default",
      style: {
        stroke: leaf.on
          ? "oklch(0.68 0.11 40 / 0.45)"
          : "oklch(0.55 0.02 250 / 0.32)",
        strokeWidth: 1,
        strokeDasharray: leaf.on ? undefined : "3 4",
      },
    });
  });

  // 5) Servers hub — sibling of the host group, below it.
  // Every project server is implicitly attached to every host in the
  // project. The hub count reflects the project's server count, not
  // host.config.serverIds (which is now a "required" classification list).
  const serversHubY = groupH + SERVERS_HUB_GAP;
  const totalServers = context.projectServers.length;
  const serversHubW = Math.max(
    SERVERS_HUB_W_BASE,
    180 + totalServers * SERVERS_HUB_W_PER_SERVER,
  );
  const serversHubX = (GROUP_W - serversHubW) / 2;
  nodes.push({
    id: SERVERS_HUB_NODE_ID,
    type: "redesignServersHub",
    position: { x: serversHubX, y: serversHubY },
    style: { width: serversHubW, height: SERVERS_HUB_H },
    data: {
      kind: "servers-hub",
      totalCount: totalServers,
    },
    draggable: false,
  });

  edges.push({
    id: "host-group-to-hub",
    source: HOST_GROUP_NODE_ID,
    target: SERVERS_HUB_NODE_ID,
    type: "default",
    style: { stroke: "oklch(0.68 0.11 40 / 0.55)", strokeWidth: 1.5 },
  });

  // 6) Server cards. Render every project server (all are implicitly
  //    attached). Required (in draft.serverIds) come first with solid
  //    edges; the rest follow as optional with dashed edges. Insecure
  //    `http://` gets an amber stroke regardless.
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
  const cardsStartX = (GROUP_W - totalCardsW) / 2;
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

  // 7) Add-server pill — right of the last card, or centered under
  //    the hub when no servers exist.
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
