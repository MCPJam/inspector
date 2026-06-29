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

import {
  getMcpToolResultImageRenderPlacement,
  isMcpDirectContentImageVisible,
  isMcpDirectContentImageRendered,
  isMcpEmbeddedResourceBlobImageVisible,
  isMcpEmbeddedResourceBlobImageRendered,
  isMcpLinkedResourceBlobImageVisible,
  isMcpLinkedResourceBlobImageRendered,
  resolveEffectiveCompatRuntime,
  resolveEffectiveMcpAppsCapabilities,
} from "@/lib/client-config-v2";
import type {
  HostConfigDtoV2,
  HostStyleId,
  McpProtocolVersion,
} from "@/lib/client-config-v2";
import type { ResolvedMcpAppsCapabilities } from "@/lib/client-styles";
import {
  ALL_DISPLAY_MODES,
  MCP_APPS_DIMENSIONS,
  OPENAI_APPS_METHOD_LABELS,
} from "@/lib/apps-capability-dimensions";

export type HostConfigSectionId = "agent" | "protocol" | "apps";

export interface HostConfigSection {
  id: HostConfigSectionId;
  /** Display label — matches `host-focus-tab-defs.tsx`. */
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
 * caniuse-grade support level for a (field, host) pair. Defined here (rather
 * than in the comparison component) so the field schema can declare enum→level
 * maps; `support-level.ts` re-exports this type for its consumers.
 */
export type SupportLevel = "supported" | "partial" | "neutral" | "unsupported";

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
  | {
      kind: "enum";
      options?: ReadonlyArray<string>;
      /**
       * When set, the matrix renders a support chip (level mapped via this
       * table) instead of plain text, and the row joins coverage/filters.
       */
      support?: Readonly<Record<string, SupportLevel>>;
    }
  /** Set of modes (e.g. display modes); each candidate renders present/absent. */
  | { kind: "mode-set"; modes: ReadonlyArray<string> }
  /** Short string rendered inline. */
  | { kind: "string" }
  /** Long string (system prompt). Matrix shows first-line preview + char count. */
  | { kind: "string-long" }
  | { kind: "string-array" }
  /**
   * MCP capability advertised by object *presence* (absent = not advertised).
   * Matrix renders a caniuse-style support chip; non-empty values still expand.
   */
  | { kind: "capability" }
  /** Object/Record. Matrix shows `N keys ›` summary; click to expand. */
  | { kind: "object"; itemNoun?: string };

export interface HostConfigFieldDef {
  /** Stable id; used as React key and in tests. */
  id: string;
  section: HostConfigSectionId;
  /** Within-section grouping label shown as a thin row above its fields. */
  subsection: string;
  /**
   * User-friendly label. This is the primary label both the matrix and the
   * focus tabs display to users — keep it short ("Model", "Temperature",
   * "Require tool approval"). Source of truth: editing here updates both
   * surfaces.
   */
  label: string;
  /** Dotted path against `HostConfigDtoV2` — schema identifier for tests and tooling. */
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

// ============================================================
// Effective-capability resolution (Apps section).
//
// The Apps capability rows show the EFFECTIVE per-host value: the hostStyle
// preset baseline with the user's sparse overrides merged on top — the same
// resolution the canvas/renderer use. The DTO carries `hostStyle` + `mcpProfile`,
// so `read(cfg)` can resolve directly. Results are memoized per config object
// because coverage/filter/search/divergence all call `read` repeatedly.
// ============================================================

const mcpAppsCache = new WeakMap<
  HostConfigDtoV2,
  ResolvedMcpAppsCapabilities
>();
const effMcpApps = (cfg: HostConfigDtoV2): ResolvedMcpAppsCapabilities => {
  let v = mcpAppsCache.get(cfg);
  if (!v) {
    v = resolveEffectiveMcpAppsCapabilities({
      profile: cfg.mcpProfile,
      hostStyle: cfg.hostStyle,
    });
    mcpAppsCache.set(cfg, v);
  }
  return v;
};

type EffCompat = ReturnType<typeof resolveEffectiveCompatRuntime>;
const compatCache = new WeakMap<HostConfigDtoV2, EffCompat>();
const effCompat = (cfg: HostConfigDtoV2): EffCompat => {
  let v = compatCache.get(cfg);
  if (!v) {
    v = resolveEffectiveCompatRuntime({
      profile: cfg.mcpProfile,
      hostStyle: cfg.hostStyle,
    });
    compatCache.set(cfg, v);
  }
  return v;
};

const DISPLAY_MODE_SUPPORT: Readonly<Record<string, SupportLevel>> = {
  accept: "supported",
  "user-initiated-only": "partial",
  decline: "neutral",
};
const REQUEST_DISPLAY_MODE_SUPPORT: Readonly<Record<string, SupportLevel>> = {
  all: "supported",
  "fullscreen-only": "partial",
  none: "neutral",
};

/** "MCP Apps capabilities" subsection — effective SEP-1865 spec-bridge matrix. */
const APPS_MCP_CAP_FIELDS: ReadonlyArray<HostConfigFieldDef> = [
  {
    id: "appsCap.availableDisplayModes",
    section: "apps",
    subsection: "MCP Apps capabilities",
    label: "availableDisplayModes",
    path: "mcpProfile.apps.mcpAppsOverrides.availableDisplayModes (effective)",
    description:
      "Display modes the host offers widgets (inline / fullscreen / pip).",
    kind: { kind: "mode-set", modes: ALL_DISPLAY_MODES },
    read: (cfg) => effMcpApps(cfg).availableDisplayModes,
  },
  {
    id: "appsCap.widgetDisplayModeRequests",
    section: "apps",
    subsection: "MCP Apps capabilities",
    label: "widgetDisplayModeRequests",
    path: "mcpProfile.apps.mcpAppsOverrides.widgetDisplayModeRequests (effective)",
    description: "Policy for honoring widget display-mode change requests.",
    kind: { kind: "enum", support: DISPLAY_MODE_SUPPORT },
    read: (cfg) => effMcpApps(cfg).widgetDisplayModeRequests,
  },
  ...MCP_APPS_DIMENSIONS.map(
    ({ key, description }): HostConfigFieldDef => ({
      id: `appsCap.${key}`,
      section: "apps",
      subsection: "MCP Apps capabilities",
      label: key,
      path: `mcpProfile.apps.mcpAppsOverrides.${key} (effective)`,
      description,
      kind: { kind: "boolean" },
      read: (cfg) => effMcpApps(cfg)[key],
    })
  ),
];

/** "OpenAI compat shim" subsection — effective window.openai surface. */
const OPENAI_SHIM_FIELDS: ReadonlyArray<HostConfigFieldDef> = [
  {
    // Keeps the `compatRuntime.openaiApps` id so the editor's
    // `hostConfigField("compatRuntime.openaiApps")` label lookup still resolves;
    // the matrix shows the EFFECTIVE injected boolean rather than the raw tri-state.
    id: "compatRuntime.openaiApps",
    section: "apps",
    subsection: "OpenAI compat shim",
    label: "Inject window.openai",
    path: "mcpProfile.apps.compatRuntime.openaiApps",
    description:
      "Inject the `window.openai` Apps-SDK shim. Undefined = use hostStyle preset.",
    kind: { kind: "boolean" },
    read: (cfg) => effCompat(cfg).injected,
  },
  ...OPENAI_APPS_METHOD_LABELS.filter(
    ({ key }) => key !== "requestDisplayMode"
  ).map(
    ({ key, label }): HostConfigFieldDef => ({
      id: `openaiShim.${key}`,
      section: "apps",
      subsection: "OpenAI compat shim",
      label,
      path: `mcpProfile.apps.compatRuntime.openaiAppsOverrides.${key} (effective)`,
      description: `window.openai.${key}() available to widgets (shim must be injected).`,
      kind: { kind: "boolean" },
      read: (cfg) => {
        const c = effCompat(cfg);
        return c.injected ? Boolean(c.capabilities[key]) : false;
      },
    })
  ),
  {
    id: "openaiShim.requestDisplayMode",
    section: "apps",
    subsection: "OpenAI compat shim",
    label: "requestDisplayMode",
    path: "mcpProfile.apps.compatRuntime.openaiAppsOverrides.requestDisplayMode (effective)",
    description: "Which display-mode requests the shim honors.",
    kind: { kind: "enum", support: REQUEST_DISPLAY_MODE_SUPPORT },
    read: (cfg) => {
      const c = effCompat(cfg);
      return c.injected ? c.capabilities.requestDisplayMode : "none";
    },
  },
];

/** "Sandbox permissions" subsection — per-permission allow flags. */
const SANDBOX_PERMISSION_KEYS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;
const SANDBOX_PERMISSION_FIELDS: ReadonlyArray<HostConfigFieldDef> =
  SANDBOX_PERMISSION_KEYS.map(
    (key): HostConfigFieldDef => ({
      id: `sandboxPerm.${key}`,
      section: "apps",
      subsection: "Sandbox permissions",
      label: key,
      path: `mcpProfile.apps.sandbox.permissions.allow.${key}`,
      description: `Grant the app iframe ${key} access.`,
      kind: { kind: "boolean" },
      read: (cfg) =>
        Boolean(mcpProfile(cfg)?.apps?.sandbox?.permissions?.allow?.[key]),
    })
  );

export const HOST_CONFIG_FIELDS: ReadonlyArray<HostConfigFieldDef> = [
  // ============================================================
  // Agent · Model & sampling
  // ============================================================
  {
    id: "modelId",
    section: "agent",
    subsection: "Model & sampling",
    label: "Model",
    path: "modelId",
    description: "LLM the host runs the agent on.",
    kind: { kind: "string" },
    read: (cfg) => cfg.modelId,
  },
  {
    id: "temperature",
    section: "agent",
    subsection: "Model & sampling",
    label: "Temperature",
    path: "temperature",
    description: "0–1 sampling temperature.",
    kind: { kind: "number" },
    read: (cfg) => cfg.temperature,
  },
  {
    id: "requireToolApproval",
    section: "agent",
    subsection: "Model & sampling",
    label: "Require tool approval",
    path: "requireToolApproval",
    description: "Prompts the user before each tool call.",
    kind: { kind: "boolean" },
    read: (cfg) => cfg.requireToolApproval,
  },
  {
    id: "respectToolVisibility",
    section: "agent",
    subsection: "Model & sampling",
    label: "Respect tool visibility",
    path: "respectToolVisibility",
    description: "SEP-1865 `_meta.ui.visibility` filter.",
    kind: { kind: "boolean" },
    // Pre-feature rows omit the field; `hostConfigDtoToInput` coerces it
    // to `true`, but the raw DTO can still carry `undefined`. Coerce here
    // so the matrix shows the resolved value, not "—".
    read: (cfg) => cfg.respectToolVisibility ?? true,
  },
  {
    id: "modelVisibleMcpToolResults.directContent.image",
    section: "agent",
    subsection: "Model & sampling",
    label: "Make tool image content visible to model",
    path: "modelVisibleMcpToolResults.directContent.image",
    description: "Pass MCP image content from tool results to the model.",
    kind: { kind: "boolean" },
    read: (cfg) =>
      isMcpDirectContentImageVisible(cfg.modelVisibleMcpToolResults),
  },
  {
    id: "modelVisibleMcpToolResults.embeddedResources.blob.image",
    section: "agent",
    subsection: "Model & sampling",
    label: "Make embedded resource images visible to model",
    path: "modelVisibleMcpToolResults.embeddedResources.blob.image",
    description:
      "Pass MCP embedded resource images from tool results to the model.",
    kind: { kind: "boolean" },
    read: (cfg) =>
      isMcpEmbeddedResourceBlobImageVisible(cfg.modelVisibleMcpToolResults),
  },
  {
    id: "modelVisibleMcpToolResults.linkedResources.blob.image",
    section: "agent",
    subsection: "Model & sampling",
    label: "Make resource link images visible to model",
    path: "modelVisibleMcpToolResults.linkedResources.blob.image",
    description: "Resolve MCP resource link images and pass them to the model.",
    kind: { kind: "boolean" },
    read: (cfg) =>
      isMcpLinkedResourceBlobImageVisible(cfg.modelVisibleMcpToolResults),
  },
  {
    id: "mcpToolResultImageRendering",
    section: "agent",
    subsection: "Model & sampling",
    label: "Render tool images",
    path: "mcpToolResultImageRendering.placement",
    description: "Human-facing display mode for MCP tool-returned images.",
    kind: {
      kind: "enum",
      options: ["none", "collapsed", "inline"],
    },
    read: (cfg) =>
      getMcpToolResultImageRenderPlacement(cfg.mcpToolResultImageRendering),
  },
  {
    id: "mcpToolResultImageRendering.directContent.image",
    section: "agent",
    subsection: "Model & sampling",
    label: "Render tool image content",
    path: "mcpToolResultImageRendering.directContent.image",
    description: "Render direct MCP image content from tool results in the UI.",
    kind: { kind: "boolean" },
    read: (cfg) =>
      isMcpDirectContentImageRendered(cfg.mcpToolResultImageRendering),
  },
  {
    id: "mcpToolResultImageRendering.embeddedResources.blob.image",
    section: "agent",
    subsection: "Model & sampling",
    label: "Render embedded resource images",
    path: "mcpToolResultImageRendering.embeddedResources.blob.image",
    description:
      "Render MCP embedded resource images from tool results in the UI.",
    kind: { kind: "boolean" },
    read: (cfg) =>
      isMcpEmbeddedResourceBlobImageRendered(cfg.mcpToolResultImageRendering),
  },
  {
    id: "mcpToolResultImageRendering.linkedResources.blob.image",
    section: "agent",
    subsection: "Model & sampling",
    label: "Render resource link images",
    path: "mcpToolResultImageRendering.linkedResources.blob.image",
    description: "Resolve MCP resource link images and render them in the UI.",
    kind: { kind: "boolean" },
    read: (cfg) =>
      isMcpLinkedResourceBlobImageRendered(cfg.mcpToolResultImageRendering),
  },
  {
    id: "progressiveToolDiscovery",
    section: "agent",
    subsection: "Model & sampling",
    label: "Progressive tools",
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
    label: "System prompt",
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
    label: "Protocol version",
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
    label: "Supported protocol versions",
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
    label: "Client name",
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
    label: "Client version",
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
    label: "Roots",
    path: "clientCapabilities.roots",
    description: "Filesystem roots exposed to the server.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.roots,
  },
  {
    id: "capabilities.sampling",
    section: "protocol",
    subsection: "Client capabilities advertised",
    label: "Sampling",
    path: "clientCapabilities.sampling",
    description: "Server-initiated LLM calls.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.sampling,
  },
  {
    id: "capabilities.elicitation",
    section: "protocol",
    subsection: "Client capabilities advertised",
    label: "Elicitation",
    path: "clientCapabilities.elicitation",
    description: "Mid-call structured prompts back to the user.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.elicitation,
  },
  {
    id: "capabilities.experimental",
    section: "protocol",
    subsection: "Client capabilities advertised",
    label: "Experimental",
    path: "clientCapabilities.experimental",
    description: "Vendor-extension capabilities.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.experimental,
  },

  // ============================================================
  // Protocol · Connection defaults
  // ============================================================
  {
    id: "connectionDefaults.requestTimeout",
    section: "protocol",
    subsection: "Connection defaults",
    label: "Request timeout",
    path: "connectionDefaults.requestTimeout",
    description: "Outbound MCP request timeout.",
    kind: { kind: "duration-ms" },
    read: (cfg) => cfg.connectionDefaults?.requestTimeout,
  },
  {
    id: "connectionDefaults.headers",
    section: "protocol",
    subsection: "Connection defaults",
    label: "Default headers",
    path: "connectionDefaults.headers",
    description: "Default outbound headers (Authorization, etc.).",
    kind: { kind: "object", itemNoun: "header" },
    read: (cfg) => cfg.connectionDefaults?.headers,
  },

  // ============================================================
  // Apps · MCP Apps capabilities (effective per-host SEP-1865 matrix)
  // ============================================================
  ...APPS_MCP_CAP_FIELDS,

  // ============================================================
  // Apps · OpenAI compat shim (effective window.openai surface)
  // ============================================================
  ...OPENAI_SHIM_FIELDS,

  // ============================================================
  // Apps · MCP Apps spec bridge (config)
  // ============================================================
  {
    id: "mcpAppsOverrides",
    section: "apps",
    subsection: "MCP Apps spec bridge",
    label: "Spec-bridge overrides",
    path: "mcpProfile.apps.mcpAppsOverrides",
    description:
      "Sparse per-dimension overrides on the SEP-1865 capability matrix.",
    kind: { kind: "object", itemNoun: "dimension" },
    read: (cfg) => mcpProfile(cfg)?.apps?.mcpAppsOverrides,
  },
  {
    id: "uiInitialize.hostInfo",
    section: "apps",
    subsection: "MCP Apps spec bridge",
    label: "ui/initialize hostInfo",
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
    label: "CSP mode",
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
    label: "Permissions mode",
    path: "mcpProfile.apps.sandbox.permissions.mode",
    description: "How spec permissions resolve in the iframe sandbox.",
    kind: {
      kind: "enum",
      options: ["resource-declared", "deny-all", "custom"] as const,
    },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.permissions?.mode,
  },
  ...SANDBOX_PERMISSION_FIELDS,
  {
    id: "sandbox.sandboxAttrs",
    section: "apps",
    subsection: "Sandbox",
    label: "Sandbox attrs",
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
    label: "Permissions Policy features",
    path: "mcpProfile.apps.sandbox.allowFeatures",
    description: "Permissions Policy entries appended to the outer iframe.",
    kind: { kind: "object", itemNoun: "feature" },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.allowFeatures,
  },
];

// ============================================================
// Field-id lookup (for focus tabs to consume labels/descriptions)
// ============================================================

/**
 * Map of field id → field def for O(1) lookup. Built lazily so the array
 * stays the canonical declaration order; the map is purely a convenience
 * for the focus tab consumers.
 */
const fieldById = new Map(HOST_CONFIG_FIELDS.map((f) => [f.id, f]));

/**
 * Look up a field by id. Throws if the id isn't registered — focus tabs
 * pass static literal ids, so a typo should fail loudly at the first
 * render in dev rather than silently miss the rename.
 */
export function hostConfigField(id: string): HostConfigFieldDef {
  const f = fieldById.get(id);
  if (!f) {
    throw new Error(
      `hostConfigField: unknown field id "${id}". ` +
        `Did you rename it in host-config-field-schema.ts without updating callers?`
    );
  }
  return f;
}

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
          (value as Record<string, unknown>)[k]
        )}`
    )
    .join(",")}}`;
}

/** True when at least two hosts disagree on this field's value. */
export function fieldDiverges(
  field: HostConfigFieldDef,
  hosts: ReadonlyArray<HostConfigDtoV2>
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
  fields: ReadonlyArray<HostConfigFieldDef> = HOST_CONFIG_FIELDS
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
