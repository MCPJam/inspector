/**
 * Shared metadata for every user-meaningful field on `HostConfigDtoV2`.
 *
 * Single source of truth for the host-config comparison matrix
 * (`/clients/compare`). Drives section order, subsection grouping, field
 * labels, descriptions, dotted paths, and value extraction. Focus tabs
 * (`BehaviorTab`, `ProtocolTab`, `AppsExtensionTab`) currently maintain
 * their own labels/descriptions inline; they can adopt entries from this
 * schema incrementally without changing their editor logic — start with
 * the description strings, then the paths.
 */

import type {
  HostConfigDtoV2,
  HostStyleId,
  McpProtocolVersion,
} from "@/lib/client-config-v2";

export type HostConfigSectionId = "agent" | "protocol" | "apps";

export interface HostConfigSection {
  id: HostConfigSectionId;
  /** Display label — matches `client-focus-tab-defs.tsx`. */
  label: string;
  /** Sub-line shown next to the section title in the matrix header band. */
  subtitle: string;
}

export const HOST_CONFIG_SECTIONS: ReadonlyArray<HostConfigSection> = [
  {
    id: "agent",
    label: "Agent",
    subtitle: "model · sampling · system prompt",
  },
  {
    id: "protocol",
    label: "MCP Protocol",
    subtitle: "version · clientInfo · capabilities · connection",
  },
  {
    id: "apps",
    label: "Apps",
    subtitle: "SEP-1865 advertise · compat shim · sandbox",
  },
];

/**
 * Discriminated render hint. The matrix translates this into a pill
 * variant; the comparator uses it to know how to test for equality
 * (numbers compare by ===, JSON objects compare by stable stringify).
 */
export type HostConfigFieldKind =
  | { kind: "boolean" }
  /** `true | false | undefined` where undefined = "host decides". */
  | { kind: "tri-state" }
  | { kind: "number" }
  /** Number rendered as `60,000 ms`. */
  | { kind: "duration-ms" }
  | { kind: "enum"; options?: ReadonlyArray<string> }
  /** Short string rendered inline. */
  | { kind: "string" }
  /** Long string (system prompt). Matrix shows first-line preview + char count. */
  | { kind: "string-long" }
  | { kind: "string-array" }
  /** Object/Record. Matrix shows `N keys ›` summary; click to expand. */
  | { kind: "object"; itemNoun?: string };

export interface HostConfigFieldDef {
  /** Stable id; used as React key and in tests. */
  id: string;
  section: HostConfigSectionId;
  /** Within-section grouping label shown as a thin row above its fields. */
  subsection: string;
  /** Dotted path against `HostConfigDtoV2` — shown as the row label. */
  path: string;
  /** User-friendly description; one short sentence. Optional. */
  description?: string;
  kind: HostConfigFieldKind;
  /**
   * Extract the field's value from a hydrated DTO. May return `undefined`
   * if the field is absent — the matrix renders that as `—`.
   */
  read: (cfg: HostConfigDtoV2) => unknown;
}

const mcpProfile = (cfg: HostConfigDtoV2) => cfg.mcpProfile;

export const HOST_CONFIG_FIELDS: ReadonlyArray<HostConfigFieldDef> = [
  // ============================================================
  // Agent · Model & sampling
  // ============================================================
  {
    id: "modelId",
    section: "agent",
    subsection: "Model & sampling",
    path: "modelId",
    description: "LLM the host runs the agent on.",
    kind: { kind: "string" },
    read: (cfg) => cfg.modelId,
  },
  {
    id: "temperature",
    section: "agent",
    subsection: "Model & sampling",
    path: "temperature",
    description: "0–1 sampling temperature.",
    kind: { kind: "number" },
    read: (cfg) => cfg.temperature,
  },
  {
    id: "requireToolApproval",
    section: "agent",
    subsection: "Model & sampling",
    path: "requireToolApproval",
    description: "Prompts the user before each tool call.",
    kind: { kind: "boolean" },
    read: (cfg) => cfg.requireToolApproval,
  },
  {
    id: "respectToolVisibility",
    section: "agent",
    subsection: "Model & sampling",
    path: "respectToolVisibility",
    description: "SEP-1865 `_meta.ui.visibility` filter.",
    kind: { kind: "boolean" },
    // Pre-feature rows omit the field; `hostConfigDtoToInput` coerces it
    // to `true`, but the raw DTO can still carry `undefined`. Coerce here
    // so the matrix shows the resolved value, not "—".
    read: (cfg) => cfg.respectToolVisibility ?? true,
  },
  {
    id: "progressiveToolDiscovery",
    section: "agent",
    subsection: "Model & sampling",
    path: "progressiveToolDiscovery",
    description:
      "search_mcp_tools / load_mcp_tools meta-tools above context thresholds. Undefined = host decides.",
    kind: { kind: "tri-state" },
    read: (cfg) => cfg.progressiveToolDiscovery,
  },

  // ============================================================
  // Agent · System prompt
  // ============================================================
  {
    id: "systemPrompt",
    section: "agent",
    subsection: "System prompt",
    path: "systemPrompt",
    description: "Verbatim system prompt sent on every turn.",
    kind: { kind: "string-long" },
    read: (cfg) => cfg.systemPrompt,
  },

  // ============================================================
  // Protocol · Version
  // ============================================================
  {
    id: "mcpProtocolVersion",
    section: "protocol",
    subsection: "Version",
    path: "mcpProfile.mcpProtocolVersion",
    description:
      "Host default pin. Per-server overrides win. Undefined = SDK chooses at request time.",
    kind: {
      kind: "enum",
      options: [
        "2025-03-26",
        "2025-06-18",
        "2025-11-25",
        "2026-07-28",
      ] as ReadonlyArray<McpProtocolVersion>,
    },
    read: (cfg) => mcpProfile(cfg)?.mcpProtocolVersion,
  },
  {
    id: "supportedProtocolVersions",
    section: "protocol",
    subsection: "Version",
    path: "mcpProfile.initialize.supportedProtocolVersions",
    description: "Accept-list advertised in the initialize handshake.",
    kind: { kind: "string-array" },
    read: (cfg) => mcpProfile(cfg)?.initialize?.supportedProtocolVersions,
  },

  // ============================================================
  // Protocol · clientInfo
  // ============================================================
  {
    id: "clientInfo.name",
    section: "protocol",
    subsection: "clientInfo",
    path: "mcpProfile.initialize.clientInfo.name",
    description: "`initialize.clientInfo.name` sent to the server.",
    kind: { kind: "string" },
    read: (cfg) => {
      const info = mcpProfile(cfg)?.initialize?.clientInfo;
      return typeof info?.name === "string" ? info.name : undefined;
    },
  },
  {
    id: "clientInfo.version",
    section: "protocol",
    subsection: "clientInfo",
    path: "mcpProfile.initialize.clientInfo.version",
    description: "`initialize.clientInfo.version` sent to the server.",
    kind: { kind: "string" },
    read: (cfg) => {
      const info = mcpProfile(cfg)?.initialize?.clientInfo;
      return typeof info?.version === "string" ? info.version : undefined;
    },
  },

  // ============================================================
  // Protocol · Client capabilities advertised
  // ============================================================
  {
    id: "capabilities.roots",
    section: "protocol",
    subsection: "Client capabilities advertised",
    path: "clientCapabilities.roots",
    description: "Filesystem roots exposed to the server.",
    kind: { kind: "object", itemNoun: "key" },
    read: (cfg) => cfg.clientCapabilities?.roots,
  },
  {
    id: "capabilities.sampling",
    section: "protocol",
    subsection: "Client capabilities advertised",
    path: "clientCapabilities.sampling",
    description: "Server-initiated LLM calls.",
    kind: { kind: "object", itemNoun: "key" },
    read: (cfg) => cfg.clientCapabilities?.sampling,
  },
  {
    id: "capabilities.elicitation",
    section: "protocol",
    subsection: "Client capabilities advertised",
    path: "clientCapabilities.elicitation",
    description: "Mid-call structured prompts back to the user.",
    kind: { kind: "object", itemNoun: "key" },
    read: (cfg) => cfg.clientCapabilities?.elicitation,
  },
  {
    id: "capabilities.experimental",
    section: "protocol",
    subsection: "Client capabilities advertised",
    path: "clientCapabilities.experimental",
    description: "Vendor-extension capabilities.",
    kind: { kind: "object", itemNoun: "key" },
    read: (cfg) => cfg.clientCapabilities?.experimental,
  },

  // ============================================================
  // Protocol · Connection defaults
  // ============================================================
  {
    id: "connectionDefaults.requestTimeout",
    section: "protocol",
    subsection: "Connection defaults",
    path: "connectionDefaults.requestTimeout",
    description: "Outbound MCP request timeout.",
    kind: { kind: "duration-ms" },
    read: (cfg) => cfg.connectionDefaults?.requestTimeout,
  },
  {
    id: "connectionDefaults.headers",
    section: "protocol",
    subsection: "Connection defaults",
    path: "connectionDefaults.headers",
    description: "Default outbound headers (Authorization, etc.).",
    kind: { kind: "object", itemNoun: "header" },
    read: (cfg) => cfg.connectionDefaults?.headers,
  },

  // ============================================================
  // Apps · Advertise
  // ============================================================
  {
    id: "hostCapabilitiesOverride",
    section: "apps",
    subsection: "Advertise & capability",
    path: "hostCapabilitiesOverride",
    description:
      "User override on SEP-1865 hostCapabilities. Absent = use the hostStyle preset.",
    kind: { kind: "object", itemNoun: "field" },
    read: (cfg) => cfg.hostCapabilitiesOverride,
  },

  // ============================================================
  // Apps · OpenAI compat shim
  // ============================================================
  {
    id: "compatRuntime.openaiApps",
    section: "apps",
    subsection: "OpenAI compat shim",
    path: "mcpProfile.apps.compatRuntime.openaiApps",
    description:
      "Inject the `window.openai` Apps-SDK shim. Undefined = use hostStyle preset.",
    kind: { kind: "tri-state" },
    read: (cfg) => mcpProfile(cfg)?.apps?.compatRuntime?.openaiApps,
  },
  {
    id: "compatRuntime.openaiAppsOverrides",
    section: "apps",
    subsection: "OpenAI compat shim",
    path: "mcpProfile.apps.compatRuntime.openaiAppsOverrides",
    description: "Sparse per-method overrides on the shim surface.",
    kind: { kind: "object", itemNoun: "method" },
    read: (cfg) => mcpProfile(cfg)?.apps?.compatRuntime?.openaiAppsOverrides,
  },

  // ============================================================
  // Apps · MCP Apps spec-bridge overrides
  // ============================================================
  {
    id: "mcpAppsOverrides",
    section: "apps",
    subsection: "MCP Apps spec bridge",
    path: "mcpProfile.apps.mcpAppsOverrides",
    description: "Sparse per-dimension overrides on the SEP-1865 capability matrix.",
    kind: { kind: "object", itemNoun: "dimension" },
    read: (cfg) => mcpProfile(cfg)?.apps?.mcpAppsOverrides,
  },
  {
    id: "uiInitialize.hostInfo",
    section: "apps",
    subsection: "MCP Apps spec bridge",
    path: "mcpProfile.apps.uiInitialize.hostInfo",
    description: "Override the `hostInfo` advertised in `ui/initialize`.",
    kind: { kind: "object", itemNoun: "field" },
    read: (cfg) => mcpProfile(cfg)?.apps?.uiInitialize?.hostInfo,
  },

  // ============================================================
  // Apps · Sandbox
  // ============================================================
  {
    id: "sandbox.csp.mode",
    section: "apps",
    subsection: "Sandbox",
    path: "mcpProfile.apps.sandbox.csp.mode",
    description: "Starting CSP baseline for app iframes.",
    kind: {
      kind: "enum",
      options: ["host-default", "declared", "relaxed"] as const,
    },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.csp?.mode,
  },
  {
    id: "sandbox.permissions.mode",
    section: "apps",
    subsection: "Sandbox",
    path: "mcpProfile.apps.sandbox.permissions.mode",
    description: "How spec permissions resolve in the iframe sandbox.",
    kind: {
      kind: "enum",
      options: ["resource-declared", "deny-all", "custom"] as const,
    },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.permissions?.mode,
  },
  {
    id: "sandbox.permissions.allow",
    section: "apps",
    subsection: "Sandbox",
    path: "mcpProfile.apps.sandbox.permissions.allow",
    description: "Per-permission allow flags (camera, microphone, etc.).",
    kind: { kind: "object", itemNoun: "permission" },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.permissions?.allow,
  },
  {
    id: "sandbox.sandboxAttrs",
    section: "apps",
    subsection: "Sandbox",
    path: "mcpProfile.apps.sandbox.sandboxAttrs",
    description:
      "Extra iframe `sandbox=` tokens unioned with `allow-scripts allow-same-origin`.",
    kind: { kind: "string-array" },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.sandboxAttrs,
  },
  {
    id: "sandbox.allowFeatures",
    section: "apps",
    subsection: "Sandbox",
    path: "mcpProfile.apps.sandbox.allowFeatures",
    description: "Permissions Policy entries appended to the outer iframe.",
    kind: { kind: "object", itemNoun: "feature" },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.allowFeatures,
  },
];

// ============================================================
// Comparison helpers
// ============================================================

/**
 * Stable JSON canonicalizer for equality checks. Sorts object keys
 * recursively; arrays preserve order. Matches the backend's notion of
 * "same config" closely enough for the matrix's diverge gutter — but is
 * NOT the same function as `canonicalizeHostConfigV2` (we don't care
 * about dedupe-grade canonicality here, only stable comparison).
 */
function stableStringify(value: unknown): string {
  if (value === undefined) return "__undef__";
  if (value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      (k) =>
        `${JSON.stringify(k)}:${stableStringify(
          (value as Record<string, unknown>)[k],
        )}`,
    )
    .join(",")}}`;
}

/** True when at least two hosts disagree on this field's value. */
export function fieldDiverges(
  field: HostConfigFieldDef,
  hosts: ReadonlyArray<HostConfigDtoV2>,
): boolean {
  if (hosts.length < 2) return false;
  const first = stableStringify(field.read(hosts[0]));
  for (let i = 1; i < hosts.length; i += 1) {
    if (stableStringify(field.read(hosts[i])) !== first) return true;
  }
  return false;
}

/** Convenience: an ordered { sectionId, subsection, fields[] } grouping. */
export interface HostConfigFieldGroup {
  section: HostConfigSection;
  subsections: ReadonlyArray<{
    label: string;
    fields: ReadonlyArray<HostConfigFieldDef>;
  }>;
}

export function groupHostConfigFields(
  fields: ReadonlyArray<HostConfigFieldDef> = HOST_CONFIG_FIELDS,
): ReadonlyArray<HostConfigFieldGroup> {
  return HOST_CONFIG_SECTIONS.map((section) => {
    const fieldsForSection = fields.filter((f) => f.section === section.id);
    const subsectionOrder: string[] = [];
    const bySubsection = new Map<string, HostConfigFieldDef[]>();
    for (const f of fieldsForSection) {
      if (!bySubsection.has(f.subsection)) {
        subsectionOrder.push(f.subsection);
        bySubsection.set(f.subsection, []);
      }
      bySubsection.get(f.subsection)!.push(f);
    }
    return {
      section,
      subsections: subsectionOrder.map((label) => ({
        label,
        fields: bySubsection.get(label)!,
      })),
    };
  });
}

// ============================================================
// Comparison subject — what the matrix actually consumes
// ============================================================

export interface HostComparisonSubject {
  hostId: string;
  hostName: string;
  hostStyle: HostStyleId;
  /** Short suffix of the hostConfigId — shown as `·a3f9d2` under the name. */
  configHashShort: string;
  config: HostConfigDtoV2;
}
