/**
 * Per-client "OpenAI plugin extensions" setting
 * (`mcpProfile.apps.pluginExtensions`) and how it resolves.
 *
 * One resolver shared by the inspector client (Playground gates, the Apps
 * tab, App-facing `experimental["openai/*"]` advertisements) and the server
 * (MCP `initialize` client capabilities, the plugin capability registry), so
 * "is this extension on for this client?" has exactly one answer.
 *
 * Browser-safe and dependency-free.
 */

import {
  PLUGIN_EXTENSION_CAPABILITY_KEYS,
  type HostConfigMcpProfileV1,
  type PluginExtensionCapabilityKey,
} from "./types.js";

export type PluginExtensionCapabilities = Record<
  PluginExtensionCapabilityKey,
  boolean
>;

export interface ResolvedPluginExtensions {
  /** Master switch, after applying the client style default. */
  enabled: boolean;
  /** True when the client saved an explicit setting (not the style default). */
  explicit: boolean;
  /** Each extension's effective state. Every value is false when disabled. */
  capabilities: PluginExtensionCapabilities;
}

export interface PluginExtensionsHostInput {
  hostStyle?: string | null;
  harness?: string | null;
  mcpProfile?: HostConfigMcpProfileV1 | Record<string, unknown> | null;
}

/**
 * Client styles whose real counterpart supports OpenAI plugin extensions.
 * Everything else (Cursor, VS Code, Mistral, Goose, Slack, Copilot, …) is
 * off unless the client explicitly turns the setting on — even when it
 * shares ChatGPT's visual family.
 */
const DEFAULT_ON_HOST_STYLES: ReadonlySet<string> = new Set([
  "chatgpt",
  "codex",
]);

/** Style default used when a client has no explicit setting saved. */
export function pluginExtensionsDefaultEnabled(
  input: Pick<PluginExtensionsHostInput, "hostStyle" | "harness">
): boolean {
  return (
    (typeof input.hostStyle === "string" &&
      DEFAULT_ON_HOST_STYLES.has(input.hostStyle)) ||
    input.harness === "codex"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read the saved setting, tolerating malformed data as "not set". */
export function readPluginExtensionsSetting(
  mcpProfile: PluginExtensionsHostInput["mcpProfile"]
): {
  enabled: boolean;
  capabilities: Partial<Record<PluginExtensionCapabilityKey, boolean>>;
} | null {
  if (!isRecord(mcpProfile)) return null;
  const apps = mcpProfile.apps;
  if (!isRecord(apps)) return null;
  const setting = apps.pluginExtensions;
  if (!isRecord(setting) || typeof setting.enabled !== "boolean") return null;
  const capabilities: Partial<Record<PluginExtensionCapabilityKey, boolean>> =
    {};
  if (isRecord(setting.capabilities)) {
    for (const key of PLUGIN_EXTENSION_CAPABILITY_KEYS) {
      const value = setting.capabilities[key];
      if (typeof value === "boolean") capabilities[key] = value;
    }
  }
  return { enabled: setting.enabled, capabilities };
}

/**
 * Resolve a client's plugin extensions. Master off (explicitly, or by style
 * default) turns every capability off; master on turns every capability on
 * except the ones explicitly switched off.
 */
export function resolvePluginExtensions(
  input: PluginExtensionsHostInput | null | undefined
): ResolvedPluginExtensions {
  const setting = readPluginExtensionsSetting(input?.mcpProfile);
  const enabled = setting
    ? setting.enabled
    : pluginExtensionsDefaultEnabled(input ?? {});
  const capabilities = {} as PluginExtensionCapabilities;
  for (const key of PLUGIN_EXTENSION_CAPABILITY_KEYS) {
    capabilities[key] = enabled && setting?.capabilities[key] !== false;
  }
  return { enabled, explicit: setting !== null, capabilities };
}

/**
 * The OpenAI form extensions a client advertises in MCP `initialize`
 * (`capabilities.extensions`). Real Codex 0.158+ sends both.
 */
export const OPENAI_FORM_CLIENT_EXTENSION_KEYS = [
  "openai/elicitation",
  "openai/form",
] as const;

/**
 * Server-facing (`initialize`) client capabilities with the OpenAI form
 * extensions removed when this client's forms extension is off. Never ADDS
 * a claim: what is advertised when on is the client's own capture (and the
 * extension host's handler, which adds `openai/elicitation` itself).
 */
export function applyPluginExtensionsToClientCapabilities(
  clientCapabilities: Record<string, unknown> | undefined,
  resolved: Pick<ResolvedPluginExtensions, "capabilities">
): Record<string, unknown> {
  const capabilities = { ...(clientCapabilities ?? {}) };
  if (resolved.capabilities.forms) return capabilities;
  for (const field of ["extensions", "experimental"] as const) {
    const value = capabilities[field];
    if (!isRecord(value)) continue;
    const kept = Object.fromEntries(
      Object.entries(value).filter(
        ([key]) =>
          !(OPENAI_FORM_CLIENT_EXTENSION_KEYS as readonly string[]).includes(
            key
          )
      )
    );
    if (Object.keys(kept).length > 0) capabilities[field] = kept;
    else delete capabilities[field];
  }
  return capabilities;
}
