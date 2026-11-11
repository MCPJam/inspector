/**
 * How a client's plugin extensions behave
 * (`mcpProfile.apps.pluginExtensions.behavior`), and what each client style
 * gets when it saved nothing: the master switch, which extensions are on, and
 * each behavior field.
 *
 * ChatGPT's rules are the default for every style. Claude clients follow
 * Claude's MCP Apps docs instead (claude.com/docs/connectors/building/mcp-apps),
 * so an App behaves in MCPJam the way it would in Claude.
 *
 * Browser-safe and dependency-free.
 */

import type {
  HostConfigMcpProfileV1,
  PluginExtensionCapabilityKey,
} from "./types.js";

/**
 * The values each behavior field accepts; the first is ChatGPT's. The
 * backend hand-mirrors these lists in `convex/lib/pluginExtensionBehavior.ts`;
 * keep the two equal.
 *
 * - `displayHints`: where an App's display hints are read, the resource's
 *   `_meta["openai/ui"]` or its `_meta.ui`.
 * - `displayStart`: the hints pick the starting mode, or the App starts
 *   inline and moves once to the side panel.
 * - `entrypointVisibility`: whether an entry point's tool must be visible to
 *   the model to be listed.
 * - `entrypointWithoutFullscreen`: an entry App that can't go full screen is
 *   refused, or opens inline.
 * - `entrypointNames`: which tool names an entry point can open.
 * - `entrypointQuickActions`: whether quick actions are listed.
 */
export const PLUGIN_EXTENSION_BEHAVIOR_VALUES = {
  displayHints: ["openai/ui", "ui"],
  displayStart: ["hint-first", "inline-then-move"],
  entrypointVisibility: ["ignore", "require-model"],
  entrypointWithoutFullscreen: ["refuse", "inline"],
  entrypointNames: ["any", "no-double-separators"],
  entrypointQuickActions: ["show", "hide"],
} as const;

export type PluginExtensionBehaviorKey =
  keyof typeof PLUGIN_EXTENSION_BEHAVIOR_VALUES;

export type HostConfigPluginExtensionBehaviorV1 = {
  [
    K in PluginExtensionBehaviorKey
  ]?: (typeof PLUGIN_EXTENSION_BEHAVIOR_VALUES)[K][number];
};

/** Every behavior field, after the client style's defaults. */
export type ResolvedPluginExtensionBehavior =
  Required<HostConfigPluginExtensionBehaviorV1>;

type BehaviorValue<K extends PluginExtensionBehaviorKey> =
  (typeof PLUGIN_EXTENSION_BEHAVIOR_VALUES)[K][number];

const BEHAVIOR_PATH = "mcpProfile.apps.pluginExtensions.behavior";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isBehaviorKey(key: string): key is PluginExtensionBehaviorKey {
  return Object.hasOwn(PLUGIN_EXTENSION_BEHAVIOR_VALUES, key);
}

function isBehaviorValue<K extends PluginExtensionBehaviorKey>(
  key: K,
  value: unknown
): value is BehaviorValue<K> {
  const allowed: readonly string[] = PLUGIN_EXTENSION_BEHAVIOR_VALUES[key];
  return typeof value === "string" && allowed.includes(value);
}

/** Generic over the key, so the write is checked against that field's values. */
function setBehaviorValue<K extends PluginExtensionBehaviorKey>(
  out: { [P in K]?: BehaviorValue<P> },
  key: K,
  value: BehaviorValue<K>
): void {
  out[key] = value;
}

/**
 * Keys in sorted order, so the canonical form hashes the same however the
 * input was ordered. Strict mode refuses the first unknown key or value it
 * meets in that order, as the backend validator does; lenient mode drops it.
 */
function readBehaviorFields(
  input: Record<string, unknown>,
  strict: boolean
): HostConfigPluginExtensionBehaviorV1 {
  const out: HostConfigPluginExtensionBehaviorV1 = {};
  for (const key of Object.keys(input).sort()) {
    if (!isBehaviorKey(key)) {
      if (strict)
        throw new Error(
          `hostConfigV2: ${BEHAVIOR_PATH} has unknown key "${key}"`
        );
      continue;
    }
    const value = input[key];
    if (isBehaviorValue(key, value)) setBehaviorValue(out, key, value);
    else if (strict) {
      const allowed: readonly string[] = PLUGIN_EXTENSION_BEHAVIOR_VALUES[key];
      throw new Error(
        `hostConfigV2: ${BEHAVIOR_PATH}.${key} must be one of ${allowed
          .map((option) => `"${option}"`)
          .join(", ")}`
      );
    }
  }
  return out;
}

/**
 * Validate and canonicalize a saved `behavior`: only the fields and values
 * above, keys sorted, and an empty object collapsed to absent so it hashes
 * like a client that saved none. Byte-identical to the backend's.
 */
export function canonicalizePluginExtensionBehavior(
  value: unknown
): HostConfigPluginExtensionBehaviorV1 | undefined {
  if (!isPlainObject(value))
    throw new Error(`hostConfigV2: ${BEHAVIOR_PATH} must be a plain object`);
  const out = readBehaviorFields(value, true);
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The valid fields of a saved `behavior`; anything malformed reads as not set. */
export function readPluginExtensionBehavior(
  value: unknown
): HostConfigPluginExtensionBehaviorV1 {
  return isPlainObject(value) ? readBehaviorFields(value, false) : {};
}

/** What a client style gets for anything it didn't save. */
export interface PluginExtensionStyleDefaults {
  /** The master switch. */
  enabled: boolean;
  /** Each extension's state while the master switch is on. */
  capabilities: Readonly<Record<PluginExtensionCapabilityKey, boolean>>;
  behavior: Readonly<ResolvedPluginExtensionBehavior>;
}

const CHATGPT_BEHAVIOR: Readonly<ResolvedPluginExtensionBehavior> =
  Object.freeze({
    displayHints: "openai/ui",
    displayStart: "hint-first",
    entrypointVisibility: "ignore",
    entrypointWithoutFullscreen: "refuse",
    entrypointNames: "any",
    entrypointQuickActions: "show",
  });

const ALL_EXTENSIONS: Readonly<Record<PluginExtensionCapabilityKey, boolean>> =
  Object.freeze({
    sidebarApps: true,
    conversationPanels: true,
    fileViewers: true,
    fileResources: true,
    localFiles: true,
    settings: true,
    displayModes: true,
    deepLinks: true,
    modelContext: true,
    messages: true,
    mentions: true,
    forms: true,
    onboarding: true,
  });

/** ChatGPT and Codex offer every extension, so it is on until switched off. */
const OPENAI_DEFAULTS: PluginExtensionStyleDefaults = Object.freeze({
  enabled: true,
  capabilities: ALL_EXTENSIONS,
  behavior: CHATGPT_BEHAVIOR,
});

/**
 * Claude, from its MCP Apps docs. Each comment names the page under
 * claude.com/docs/connectors/building/mcp-apps/ that the value follows.
 */
const CLAUDE_DEFAULTS: PluginExtensionStyleDefaults = Object.freeze({
  enabled: true,
  capabilities: Object.freeze({
    // entry-points: Claude lists global entry points under its own rules
    // (the entrypoint fields below), which the sidebar doesn't apply.
    sidebarApps: false,
    // The rest are OpenAI's extensions, which Claude doesn't document: off
    // until someone switches one on.
    conversationPanels: false,
    fileViewers: false,
    fileResources: false,
    localFiles: false,
    settings: false,
    // display-modes: Apps show in the conversation, the side panel or full screen.
    displayModes: true,
    deepLinks: false,
    modelContext: false,
    messages: false,
    mentions: false,
    forms: false,
    onboarding: false,
  }),
  behavior: Object.freeze({
    // display-modes: `preferredDisplayMode` is read from the resource's `_meta.ui`.
    displayHints: "ui",
    // display-modes: a view starts in the conversation, then moves once to the
    // side panel after its tool call returns without an error.
    displayStart: "inline-then-move",
    // entry-points: a tool is listed only when `_meta.ui.visibility` is
    // omitted or includes "model".
    entrypointVisibility: "require-model",
    // entry-points: a view without `fullscreen` appears in the conversation.
    entrypointWithoutFullscreen: "inline",
    // entry-points: a name with two underscores or dots in a row, or a dot
    // next to an underscore, is listed but can't be opened.
    entrypointNames: "no-double-separators",
    // entry-points: only `global` entry points are documented.
    entrypointQuickActions: "hide",
  }),
});

/**
 * Every other style (Cursor, VS Code, Goose, …) is off until the client turns
 * it on, even when it shares ChatGPT's look, then gets ChatGPT's rules.
 */
const OTHER_STYLE_DEFAULTS: PluginExtensionStyleDefaults = Object.freeze({
  enabled: false,
  capabilities: ALL_EXTENSIONS,
  behavior: CHATGPT_BEHAVIOR,
});

/** Defaults by client style; a style not named here gets `OTHER_STYLE_DEFAULTS`. */
export const PLUGIN_EXTENSION_STYLE_DEFAULTS: Readonly<
  Partial<Record<string, PluginExtensionStyleDefaults>>
> = Object.freeze({
  chatgpt: OPENAI_DEFAULTS,
  codex: OPENAI_DEFAULTS,
  claude: CLAUDE_DEFAULTS,
  "claude-desktop": CLAUDE_DEFAULTS,
});

export interface PluginExtensionStyleInput {
  hostStyle?: string | null;
  harness?: string | null;
}

/** A client on the Codex harness is Codex, whatever style it is drawn in. */
export function pluginExtensionStyleDefaults(
  input: PluginExtensionStyleInput
): PluginExtensionStyleDefaults {
  if (input.harness === "codex") return OPENAI_DEFAULTS;
  const style = input.hostStyle;
  const named =
    typeof style === "string" &&
    Object.hasOwn(PLUGIN_EXTENSION_STYLE_DEFAULTS, style)
      ? PLUGIN_EXTENSION_STYLE_DEFAULTS[style]
      : undefined;
  return named ?? OTHER_STYLE_DEFAULTS;
}

/** The saved `behavior`, read only from a well-formed setting. */
function savedBehavior(
  mcpProfile:
    HostConfigMcpProfileV1 | Record<string, unknown> | null | undefined
): HostConfigPluginExtensionBehaviorV1 {
  if (!isPlainObject(mcpProfile) || !isPlainObject(mcpProfile.apps)) return {};
  const setting = mcpProfile.apps.pluginExtensions;
  if (!isPlainObject(setting) || typeof setting.enabled !== "boolean")
    return {};
  return readPluginExtensionBehavior(setting.behavior);
}

/** Each field is the saved value, else the client style's default. */
export function resolvePluginExtensionBehavior(
  input:
    | (PluginExtensionStyleInput & {
        mcpProfile?: HostConfigMcpProfileV1 | Record<string, unknown> | null;
      })
    | null
    | undefined
): ResolvedPluginExtensionBehavior {
  return {
    ...pluginExtensionStyleDefaults(input ?? {}).behavior,
    ...savedBehavior(input?.mcpProfile),
  };
}
