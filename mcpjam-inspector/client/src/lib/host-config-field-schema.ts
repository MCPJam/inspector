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

import type { McpUiStyleVariableKey } from "@modelcontextprotocol/ext-apps/app-bridge";
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
import {
  MCPJAM_TASKS_POLICY_EXTENSION_ID,
  MCP_SKILLS_EXTENSION_ID,
  readTasksPolicy,
} from "@mcpjam/sdk/browser";

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
  /**
   * A style variable's value, shown per theme when the host resolves its
   * tokens and sends different literals for light and dark.
   */
  | { kind: "style-variable" }
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
/**
 * `unset` is deliberately absent: the field reads it as `undefined`, which the
 * matrix already renders as "neutral"/`—`. Mapping it explicitly would be the
 * same answer by a longer route, and would suggest the host stored something.
 * `invalid` is `unsupported` rather than `neutral` — a malformed value fails
 * closed and is worth showing as a problem, not as an absence.
 */
const TASKS_POLICY_SUPPORT: Readonly<Record<string, SupportLevel>> = {
  on: "supported",
  off: "neutral",
  invalid: "unsupported",
};

/** "MCP Apps capabilities" subsection — effective SEP-1865 spec-bridge matrix. */
/**
 * Every style variable the MCP Apps spec defines, in spec order.
 *
 * Hand-listed because `McpUiStyleVariableKey` is a type-only union with no
 * runtime counterpart, and the rows have to exist for hosts that send NOTHING
 * — a host missing `--color-ring-info` must read as a gap, not as a row that
 * quietly disappears. The `satisfies` clause rejects a typo or a stale key, and
 * the assertion below fails the build if the spec adds one this list lacks.
 */
const MCP_UI_STYLE_VARIABLE_KEYS = [
  "--color-background-primary",
  "--color-background-secondary",
  "--color-background-tertiary",
  "--color-background-inverse",
  "--color-background-ghost",
  "--color-background-info",
  "--color-background-danger",
  "--color-background-success",
  "--color-background-warning",
  "--color-background-disabled",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-tertiary",
  "--color-text-inverse",
  "--color-text-ghost",
  "--color-text-info",
  "--color-text-danger",
  "--color-text-success",
  "--color-text-warning",
  "--color-text-disabled",
  "--color-border-primary",
  "--color-border-secondary",
  "--color-border-tertiary",
  "--color-border-inverse",
  "--color-border-ghost",
  "--color-border-info",
  "--color-border-danger",
  "--color-border-success",
  "--color-border-warning",
  "--color-border-disabled",
  "--color-ring-primary",
  "--color-ring-secondary",
  "--color-ring-inverse",
  "--color-ring-info",
  "--color-ring-danger",
  "--color-ring-success",
  "--color-ring-warning",
  "--font-sans",
  "--font-mono",
  "--font-weight-normal",
  "--font-weight-medium",
  "--font-weight-semibold",
  "--font-weight-bold",
  "--font-text-xs-size",
  "--font-text-sm-size",
  "--font-text-md-size",
  "--font-text-lg-size",
  "--font-heading-xs-size",
  "--font-heading-sm-size",
  "--font-heading-md-size",
  "--font-heading-lg-size",
  "--font-heading-xl-size",
  "--font-heading-2xl-size",
  "--font-heading-3xl-size",
  "--font-text-xs-line-height",
  "--font-text-sm-line-height",
  "--font-text-md-line-height",
  "--font-text-lg-line-height",
  "--font-heading-xs-line-height",
  "--font-heading-sm-line-height",
  "--font-heading-md-line-height",
  "--font-heading-lg-line-height",
  "--font-heading-xl-line-height",
  "--font-heading-2xl-line-height",
  "--font-heading-3xl-line-height",
  "--border-radius-xs",
  "--border-radius-sm",
  "--border-radius-md",
  "--border-radius-lg",
  "--border-radius-xl",
  "--border-radius-full",
  "--border-width-regular",
  "--shadow-hairline",
  "--shadow-sm",
  "--shadow-md",
  "--shadow-lg",
] as const satisfies readonly McpUiStyleVariableKey[];

type UncoveredStyleVariableKey = Exclude<
  McpUiStyleVariableKey,
  (typeof MCP_UI_STYLE_VARIABLE_KEYS)[number]
>;
// Resolves to `true` only while the list covers the spec union; if the spec
// gains a key, this becomes a tuple type and the assignment stops compiling.
const _styleVariableCoverage: [UncoveredStyleVariableKey] extends [never]
  ? true
  : ["style variable rows missing spec keys", UncoveredStyleVariableKey] = true;
void _styleVariableCoverage;

/**
 * A field that is genuinely absent because someone looked, as opposed to
 * absent because nobody has looked yet. The matrix renders it as an explicit
 * "Not supported"; a plain `undefined` stays an em dash.
 */
export const NOT_SUPPORTED = Symbol("not-supported");

/** One variable's value in each theme; `same` when a single string answers both. */
export type StyleVariableByTheme =
  | { same: string }
  /**
   * `raw` is set when the pair was decoded from a single `light-dark(…)`
   * string rather than probed per theme — the split is for reading, and the
   * literal the host actually sends stays available for anyone who needs it.
   */
  | { light?: string; dark?: string; raw?: string };

/**
 * Split a CSS `light-dark(a, b)` value into its two themes.
 *
 * Hosts encode the same fact two ways: Claude sends one `light-dark(…)`
 * string, ChatGPT and Codex send a resolved literal per theme. Rendering
 * those differently makes a row impossible to compare down the column, so
 * the pair is normalized here. Returns null for anything else, including a
 * malformed call — a value we can't split is shown verbatim rather than
 * guessed at.
 *
 * Splits on the top-level comma: the arguments are themselves functions
 * (`rgba(50, 102, 173, 1)`) whose commas must not end the first argument.
 */
function hasTopLevelComma(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) return true;
  }
  return false;
}

/**
 * Whether every `(` in the value is closed, and none closes early. Guards the
 * split in {@link parseLightDarkPair}: `endsWith(")")` says nothing about
 * whether that paren belongs to the `light-dark(` we opened.
 */
function hasBalancedParens(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

export function parseLightDarkPair(
  value: string
): { light: string; dark: string } | null {
  const trimmed = value.trim();
  const prefix = "light-dark(";
  if (!trimmed.toLowerCase().startsWith(prefix) || !trimmed.endsWith(")")) {
    return null;
  }
  const inner = trimmed.slice(prefix.length, -1);
  // Balance first. Without it the scan below happily splits
  // `light-dark(#fff, rgb(0,0,0)` — which ends in `)` and has a top-level
  // comma — into a `dark` of `rgb(0,0,0`, an unclosed function we would then
  // hand to a swatch. A balanced `inner` also guarantees both halves of the
  // split are balanced, so neither side needs re-checking.
  if (!hasBalancedParens(inner)) return null;
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      const light = inner.slice(0, i).trim();
      const dark = inner.slice(i + 1).trim();
      if (!light || !dark) return null;
      // `light-dark()` takes exactly two arguments. A third top-level comma
      // means this is not a value we understand, and splitting on the first
      // one would invent a `dark` of "#000, #333" — worse than not splitting.
      if (hasTopLevelComma(dark)) return null;
      return { light, dark };
    }
  }
  return null;
}

function readStyleVariable(
  cfg: HostConfigDtoV2,
  key: McpUiStyleVariableKey
): StyleVariableByTheme | typeof NOT_SUPPORTED | undefined {
  const facts = cfg as HostConfigDtoWithCatalogFacts;
  const byTheme = facts.styleVariablesByTheme;
  const light = byTheme?.light?.[key];
  const dark = byTheme?.dark?.[key];
  if (typeof light === "string" || typeof dark === "string") {
    // A host that resolves per theme: show each capture separately, and
    // collapse when the two agree (sizes, radii and shadows usually do).
    return light === dark && typeof light === "string"
      ? { same: light }
      : { light, dark };
  }

  const styles = (cfg.hostContext as { styles?: unknown } | undefined)?.styles;
  const variables = (styles as { variables?: unknown } | undefined)?.variables;
  const value =
    variables !== null && typeof variables === "object"
      ? (variables as Record<string, unknown>)[key]
      : undefined;
  // A single value answers both themes — either because it is theme-agnostic
  // (`light-dark(…)`) or because only one theme was ever captured. Both read
  // the same way here; the catalog's per-theme pair is what distinguishes them.
  if (typeof value === "string") {
    // A `light-dark(…)` host and a per-theme-probed host state the same fact
    // in different notations; normalize so the column compares.
    const pair = parseLightDarkPair(value);
    if (!pair) return { same: value };
    // `light-dark(x, x)` states a theme-agnostic fact in a two-argument
    // notation. Collapse it exactly as the per-theme branch above collapses
    // an equal capture, or the same fact renders stacked here and bare there
    // — the split-grammar problem this function exists to remove.
    if (pair.light === pair.dark) return { same: pair.light };
    return { ...pair, raw: value };
  }

  // Only a probed host can be said not to support the variable: we connected,
  // read its host context, and it sent nothing here. For a vendor-doc or
  // assumed host the same blank means no View was ever run, which is an
  // absence of evidence rather than evidence of absence.
  return facts.provenance === "probe" ? NOT_SUPPORTED : undefined;
}

/**
 * Apps · Styles — one row per spec variable, showing the value each host sends.
 *
 * These are probed values, so the row shows them: the value a widget actually
 * receives is the comparison a widget author is here to make, and collapsing
 * it to a yes/no chip would discard the finding. Hosts differ in notation —
 * one `light-dark(…)` string vs a resolved literal per theme — so the pair is
 * normalized (`parseLightDarkPair`) and every host reads down the column the
 * same way. A probed host that sends nothing reads as an explicit "Not
 * supported"; one nobody has probed stays an em dash, so absence stays
 * legible either way.
 *
 * The trade is that value rows are not support-shaped: the only chip they ever
 * render is that `NOT_SUPPORTED` one, and they take no part in the coverage
 * percentage or the support filters.
 */
const APPS_STYLE_FIELDS: ReadonlyArray<HostConfigFieldDef> =
  MCP_UI_STYLE_VARIABLE_KEYS.map((key) => ({
    id: `styles.${key}`,
    section: "apps",
    subsection: "Styles",
    label: key,
    path: `hostContext.styles.variables.${key}`,
    description: `Value the host sends widgets for ${key}.`,
    kind: { kind: "style-variable" },
    read: (cfg) => readStyleVariable(cfg, key),
  }));

/**
 * A host the catalog says renders no MCP Apps.
 *
 * The capability resolver returns a fully-populated shape, so every host has
 * an `availableDisplayModes` and a `widgetDisplayModeRequests` whether or not
 * it can show a widget — hosts that render nothing inherit `['inline']` and
 * `'accept'` from the shared no-claims preset, which reads as an offer rather
 * than the filler it is. The boolean dimensions do not have this problem:
 * their no-claims value is `false`, which already renders as unsupported.
 *
 * Only the catalog can settle this; absent the fact (a host the user built),
 * the effective value is the honest answer and is shown as-is.
 */
function rendersNoMcpApps(cfg: HostConfigDtoV2): boolean {
  return (cfg as HostConfigDtoWithCatalogFacts).rendersMcpApps === false;
}

const APPS_MCP_CAP_FIELDS: ReadonlyArray<HostConfigFieldDef> = [
  {
    id: "appsCap.availableDisplayModes",
    section: "apps",
    subsection: "MCP Apps capabilities",
    label: "availableDisplayModes",
    path: "mcpProfile.apps.mcpAppsOverrides.availableDisplayModes (effective)",
    description:
      "Display modes the client offers widgets (inline / fullscreen / pip).",
    kind: { kind: "mode-set", modes: ALL_DISPLAY_MODES },
    read: (cfg) =>
      rendersNoMcpApps(cfg)
        ? NOT_SUPPORTED
        : effMcpApps(cfg).availableDisplayModes,
  },
  {
    id: "appsCap.widgetDisplayModeRequests",
    section: "apps",
    subsection: "MCP Apps capabilities",
    label: "widgetDisplayModeRequests",
    path: "mcpProfile.apps.mcpAppsOverrides.widgetDisplayModeRequests (effective)",
    description: "Policy for honoring widget display-mode change requests.",
    kind: { kind: "enum", support: DISPLAY_MODE_SUPPORT },
    read: (cfg) =>
      rendersNoMcpApps(cfg)
        ? NOT_SUPPORTED
        : effMcpApps(cfg).widgetDisplayModeRequests,
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
  // Read the RESOLVED matrix, not the raw override, exactly like every
  // sibling `appsCap` row above. A preset carries these subtypes (ChatGPT
  // blocks fetch/xhr, Goose blocks all three) and the sandbox proxy enforces
  // the resolved value, so reading `mcpAppsOverrides` directly would report
  // "unknown" for a row whose preset is actively restricting the widget.
  // `undefined` stays undefined: presets with no probe evidence for a
  // subtype leave it absent, and unknown is the honest answer there.
  ...(["fetch", "xhr", "websocket"] as const).map(
    (key): HostConfigFieldDef => ({
      id: `appsCap.cspConnectDomains.${key}`,
      section: "apps",
      subsection: "MCP Apps capabilities",
      label: `cspConnectDomains.${key}`,
      path: `mcpProfile.apps.mcpAppsOverrides.cspConnectDomains.${key} (effective)`,
      description: `Allow widget ${key} connections to declared CSP connect domains.`,
      kind: { kind: "boolean" },
      read: (cfg) => effMcpApps(cfg).cspConnectDomains?.[key],
    })
  ),
  ...(["script", "stylesheet", "image", "font", "media"] as const).map(
    (key): HostConfigFieldDef => ({
      id: `appsCap.cspResourceDomains.${key}`,
      section: "apps",
      subsection: "MCP Apps capabilities",
      label: `cspResourceDomains.${key}`,
      path: `mcpProfile.apps.mcpAppsOverrides.cspResourceDomains.${key} (effective)`,
      description: `Allow widget ${key} resources from declared CSP resource domains.`,
      kind: { kind: "boolean" },
      read: (cfg) => effMcpApps(cfg).cspResourceDomains?.[key],
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

/** Tool Result parts relayed back only to a widget that called the tool. */
const TOOL_RESULT_CONTENT_KINDS = [
  ["text", "Text"],
  ["image", "Image"],
  ["audio", "Audio"],
  ["resource", "Embedded resource"],
  ["resourceLink", "Resource link"],
] as const;
const TOOL_RESULT_WIDGET_FIELDS: ReadonlyArray<HostConfigFieldDef> = [
  {
    id: "toolResult.structuredContent",
    section: "apps",
    subsection: "Widget tool results",
    label: "Structured content",
    path: "mcpProfile.apps.mcpAppsOverrides.toolResult.structuredContent",
    description:
      "Whether the structuredContent half of a tool result reaches a widget that called the tool.",
    kind: { kind: "boolean" },
    read: (cfg) =>
      mcpProfile(cfg)?.apps?.mcpAppsOverrides?.toolResult?.structuredContent,
  },
  ...TOOL_RESULT_CONTENT_KINDS.map(
    ([key, label]): HostConfigFieldDef => ({
      id: `toolResult.content.${key}`,
      section: "apps",
      subsection: "Widget tool results",
      label,
      path: `mcpProfile.apps.mcpAppsOverrides.toolResult.content.${key}`,
      description: `Whether ${label.toLowerCase()} blocks in a tool result reach a widget that called the tool.`,
      kind: { kind: "boolean" },
      read: (cfg) =>
        cfg.mcpProfile?.apps?.mcpAppsOverrides?.toolResult?.content?.[key],
    })
  ),
];

/** Browser APIs observed inside the sandboxed widget iframe. */
const BROWSER_STORAGE_KEYS = [
  "localStorage",
  "sessionStorage",
  "indexedDB",
] as const;
const BROWSER_STORAGE_FIELDS: ReadonlyArray<HostConfigFieldDef> =
  BROWSER_STORAGE_KEYS.map(
    (key): HostConfigFieldDef => ({
    id: `sandbox.browserStorage.${key}`,
    section: "apps",
    subsection: "Sandbox",
    label: key === "indexedDB" ? "IndexedDB" : key,
    path: `mcpProfile.apps.sandbox.browserStorage.${key}`,
    description: `${key} works inside the sandboxed app iframe (probe-measured browser behavior, not MCP).`,
    kind: { kind: "boolean" },
    read: (cfg) => mcpProfile(cfg)?.apps?.sandbox?.browserStorage?.[key],
    })
  );

/**
 * How the client handles `notifications/tools/list_changed`. Two
 * independently-measured facts: whether it opens the server→client channel at
 * all, and whether it acts on the notification once one arrives.
 */
const TOOL_LIST_CHANGED_FIELDS: ReadonlyArray<HostConfigFieldDef> = (
  [
    [
      "listens",
      "Opens notification channel",
      "Client opens the server-to-client notification channel (legacy: standalone GET SSE stream; 2026-07-28: subscriptions/listen).",
    ],
    [
      "refetches",
      "Re-fetches after list_changed",
      "Client acts on notifications/tools/list_changed instead of keeping its cached tool list. Independent of the channel: a server can publish the notification on an open tools/call response stream, which reaches a client that never opened one.",
    ],
  ] as const
).map(
  ([key, label, description]): HostConfigFieldDef => ({
    id: `toolListChanged.${key}`,
    section: "protocol",
    subsection: "Tool list changed",
    label,
    path: `mcpProfile.toolListChanged.${key}`,
    description,
    kind: { kind: "boolean" },
    read: (cfg) => mcpProfile(cfg)?.toolListChanged?.[key],
  })
);

/**
 * `mcpProfile.paginationTraversal` — whether the client walks `nextCursor`
 * to the end of a paginated list, or stops at page one.
 *
 * Rendered as a support chip rather than the literal, because the question a
 * reader has is binary: will this host see tools past the first page? An
 * absent value maps to "unknown" through the shared fallback, so a host
 * nobody probed is never published as failing.
 */
const PAGINATION_FIELD: HostConfigFieldDef = {
  id: "paginationTraversal",
  section: "protocol",
  subsection: "Pagination",
  label: "Follows nextCursor",
  path: "mcpProfile.paginationTraversal",
  description:
    "Client requests further pages of a paginated list instead of treating page one as the whole result.",
  kind: {
    kind: "enum",
    options: ["full", "firstPageOnly"],
    support: { full: "supported", firstPageOnly: "unsupported" },
  },
  read: (cfg) => mcpProfile(cfg)?.paginationTraversal,
};

export const HOST_CONFIG_FIELDS: ReadonlyArray<HostConfigFieldDef> = [
  // ============================================================
  // Agent · Agent tooling
  // ============================================================
  {
    id: "modelId",
    section: "agent",
    subsection: "Agent tooling",
    label: "Model",
    path: "modelId",
    description: "LLM the client runs the agent on.",
    kind: { kind: "string" },
    read: (cfg) => cfg.modelId,
  },
  {
    id: "temperature",
    section: "agent",
    subsection: "Agent tooling",
    label: "Temperature",
    path: "temperature",
    description: "0–1 sampling temperature.",
    kind: { kind: "number" },
    read: (cfg) => cfg.temperature,
  },
  {
    id: "requireToolApproval",
    section: "agent",
    subsection: "Agent tooling",
    label: "Require tool approval",
    path: "requireToolApproval",
    description: "Prompts the user before each tool call.",
    kind: { kind: "boolean" },
    read: (cfg) => cfg.requireToolApproval,
  },
  {
    id: "respectToolVisibility",
    section: "agent",
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
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
    subsection: "Agent tooling",
    label: "Progressive tools",
    path: "progressiveToolDiscovery",
    description:
      "search_mcp_tools / load_mcp_tools meta-tools above context thresholds. Undefined = client decides.",
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
  // Protocol · clientInfo
  //
  // Leads the protocol section: every other row below describes facts captured
  // from one specific build of the client, so the version those facts came
  // from is the context for reading them.
  // ============================================================
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
      'Host default selection. "auto" negotiates at connect time; concrete versions pin that exact era. Per-server overrides win.',
    kind: {
      kind: "enum",
      options: [
        "auto",
        "2025-03-26",
        "2025-06-18",
        "2025-11-25",
        "2026-07-28",
      ] as ReadonlyArray<McpProtocolVersion | "auto">,
    },
    read: (cfg) => mcpProfile(cfg)?.mcpProtocolVersion,
  },
  {
    id: "supportedProtocolVersions",
    section: "protocol",
    subsection: "Version",
    label: "Supported protocol versions",
    path: "mcpProfile.initialize.supportedProtocolVersions",
    description: "Accept-list supported in the initialize handshake.",
    kind: { kind: "string-array" },
    read: (cfg) =>
      (cfg as HostConfigDtoWithCatalogFacts).supportedProtocolVersions ??
      mcpProfile(cfg)?.initialize?.supportedProtocolVersions,
  },


  // ============================================================
  // Protocol · Client capabilities supported
  // ============================================================
  {
    id: "capabilities.roots",
    section: "protocol",
    subsection: "Client capabilities supported",
    label: "Roots",
    path: "clientCapabilities.roots",
    description: "Filesystem roots exposed to the server.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.roots,
  },
  {
    id: "capabilities.sampling",
    section: "protocol",
    subsection: "Client capabilities supported",
    label: "Sampling",
    path: "clientCapabilities.sampling",
    description: "Server-initiated LLM calls.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.sampling,
  },
  {
    id: "capabilities.elicitation",
    section: "protocol",
    subsection: "Client capabilities supported",
    label: "Elicitation",
    path: "clientCapabilities.elicitation",
    description: "Mid-call structured prompts back to the user.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.elicitation,
  },
  {
    id: "capabilities.experimental",
    section: "protocol",
    subsection: "Client capabilities supported",
    label: "Experimental",
    path: "clientCapabilities.experimental",
    description: "Vendor-extension capabilities.",
    kind: { kind: "capability" },
    read: (cfg) => cfg.clientCapabilities?.experimental,
  },
  {
    // Skills over MCP (SEP-2640) — a REAL wire capability, unlike the
    // MCPJam-only tasks policy below: this key goes on the initialize
    // envelope, and declaring it commits the host to fetching, digest-
    // verifying, and refusing unlisted files. It is therefore under "Client
    // capabilities supported" rather than "Host policy".
    id: "capabilities.skillsExtension",
    section: "protocol",
    subsection: "Client capabilities supported",
    label: "Skills over MCP",
    path: `clientCapabilities.extensions.${MCP_SKILLS_EXTENSION_ID}`,
    description:
      "Server-served Agent Skills (skills/list, skills/get) with mandatory digest verification.",
    kind: { kind: "capability" },
    read: (cfg) =>
      (
        cfg.clientCapabilities?.extensions as
          | Record<string, unknown>
          | undefined
      )?.[MCP_SKILLS_EXTENSION_ID],
  },

  // ============================================================
  // Protocol · Host policy
  //
  // MCPJam's own product policy, NOT an MCP wire capability. It is stored
  // under `mcpProfile.extensions["com.mcpjam/tasks"]` and is never advertised
  // to a server — the thing that goes on the wire is
  // `io.modelcontextprotocol/tasks`, which is a different key with a different
  // meaning and lives under "Client capabilities supported".
  // ============================================================
  {
    id: "tasksPolicy",
    section: "protocol",
    subsection: "Host policy",
    label: "Task execution",
    path: `mcpProfile.extensions.${MCPJAM_TASKS_POLICY_EXTENSION_ID}.enabled`,
    description:
      "Whether surfaces beyond the Tools tab may run tools as MCP tasks.",
    // `unset` reads as `undefined`, which the enum kind maps to "neutral" —
    // so every host that has never expressed an opinion renders exactly as it
    // did before this field existed.
    kind: { kind: "enum", support: TASKS_POLICY_SUPPORT },
    read: (cfg) => {
      const policy = readTasksPolicy(cfg);
      return policy === "unset" ? undefined : policy;
    },
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
  // Apps · Styles (host theming variables)
  // ============================================================
  ...APPS_STYLE_FIELDS,

  // ============================================================
  // Apps · MCP Apps spec bridge (config)
  // ============================================================
  {
    id: "uiInitialize.hostInfo",
    section: "apps",
    subsection: "MCP Apps spec bridge",
    label: "ui/initialize hostInfo",
    path: "mcpProfile.apps.uiInitialize.hostInfo",
    description: "Override the `hostInfo` sent in `ui/initialize`.",
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
  ...BROWSER_STORAGE_FIELDS,

  // ============================================================
  // Apps · Widget tool results
  // ============================================================
  ...TOOL_RESULT_WIDGET_FIELDS,
  ...TOOL_LIST_CHANGED_FIELDS,
  PAGINATION_FIELD,
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
  const read = (cfg: HostConfigDtoV2) =>
    stableStringify(comparable(field.read(cfg)));
  const first = read(hosts[0]);
  for (let i = 1; i < hosts.length; i += 1) {
    if (read(hosts[i]) !== first) return true;
  }
  return false;
}

/**
 * Strip read-only provenance off a value before comparing two hosts.
 *
 * `raw` records the `light-dark(…)` literal a host sent so the cell can show
 * it on hover; it is not part of the fact being compared. Leaving it in makes
 * a host that sends `light-dark(a, b)` diverge from one that sends the same
 * two values per theme — two cells that now render identically, flagged as
 * different, which is exactly backwards.
 */
function comparable(value: unknown): unknown {
  if (value === null || typeof value !== "object" || !("raw" in value)) {
    return value;
  }
  const { raw: _raw, ...rest } = value as Record<string, unknown>;
  return rest;
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

/**
 * A preset/caniuse subject's config, plus the catalog facts that live beside
 * `hostConfig` in the catalog row rather than inside it. Declared instead of
 * cast at each end so the extra key is visible in the types.
 */
export type HostConfigDtoWithCatalogFacts = HostConfigDtoV2 & {
  /** Every era the client speaks; the profile's list is legacy-only. */
  supportedProtocolVersions?: string[];
  /**
   * How the catalog knows this host's facts. Carried so a field can tell
   * "we ran a probe and the host sent nothing" apart from "nobody has
   * probed this host", which look identical in the config alone.
   */
  provenance?: "probe" | "vendor-doc" | "assumed";
  /**
   * Whether this host renders MCP Apps at all. A host that renders none has
   * no display modes to offer, but the capability matrix resolves to a
   * non-optional shape, so the rows would otherwise print the preset filler.
   */
  rendersMcpApps?: boolean;
  /**
   * Style variables per theme, for hosts that resolve their tokens instead of
   * emitting `light-dark(…)`. `hostContext.styles` can only carry the one
   * theme the emulated host announces, so the pair rides beside it.
   */
  styleVariablesByTheme?: {
    light?: Record<string, string>;
    dark?: Record<string, string>;
  };
};

export interface HostComparisonSubject {
  hostId: string;
  hostName: string;
  hostStyle: HostStyleId;
  /** Short suffix of the hostConfigId — shown as `·a3f9d2` under the name. */
  configHashShort: string;
  /** Catalog verification timestamp for preset/caniuse hosts. */
  verifiedAt?: number;
  config: HostConfigDtoV2;
}
