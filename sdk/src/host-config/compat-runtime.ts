/**
 * OpenAI Apps compat resolution from a hostConfig (+ optional override).
 *
 * Pure — no Convex / Node / ai-sdk imports. The eval runner uses this to
 * decide whether to inject the OpenAI Apps compat shim into widget HTML
 * snapshots for hosts that emulate ChatGPT-style apps.
 *
 * Resolution order (first match wins):
 *   1. Explicit override on `hostConfigOverride.{mcpProfile|mcp}.apps.compatRuntime.openaiApps`
 *   2. Host-style preset from `hostConfigOverride.{hostStyle|style}`
 *   3. Explicit base on `hostConfig.{mcpProfile|mcp}.apps.compatRuntime.openaiApps`
 *   4. Host-style preset from `hostConfig.{hostStyle|style}` (defaults to `false`)
 *
 * Both canonical (`hostStyle`/`mcpProfile`) and public (`style`/`mcp`)
 * shapes are accepted because callers span: inspector eval runners
 * (canonical, via Convex) and SDK `HostRunner` / `HostRuntime` (public,
 * via `Host.toJSON()`).
 *
 * Style presets:
 *   - "chatgpt" | "copilot" | "mcpjam" → true
 *   - "claude"  | "cursor"  | "codex" | "goose" → false
 *   - anything else → undefined (falls through; ultimate default is false)
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readHostStyle(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return value.hostStyle ?? value.style;
}

function readMcpProfileOrMcp(
  value: unknown
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (isRecord(value.mcpProfile)) return value.mcpProfile;
  if (isRecord(value.mcp)) return value.mcp;
  return undefined;
}

export function readOpenAiCompatOverride(value: unknown): boolean | undefined {
  const profile = readMcpProfileOrMcp(value);
  const apps = isRecord(profile?.apps) ? profile.apps : undefined;
  const compatRuntime = isRecord(apps?.compatRuntime)
    ? apps.compatRuntime
    : undefined;
  return typeof compatRuntime?.openaiApps === "boolean"
    ? compatRuntime.openaiApps
    : undefined;
}

/**
 * OpenAI Apps compat preset per host style — the data behind
 * `compatPresetForHostStyle`. Exported as a record so the host-compat catalog
 * (`host-compat/catalog.ts`) can ship the same facts as data (backend catalog
 * publishes override these at runtime; this record is the bundled fallback).
 */
export const OPENAI_COMPAT_PRESET_BY_STYLE: Readonly<Record<string, boolean>> =
  Object.freeze({
    chatgpt: true,
    copilot: true,
    mcpjam: true,
    claude: false,
    cursor: false,
    codex: false,
    goose: false,
    slack: false,
    vscode: false,
    notion: false,
  });

export function compatPresetForHostStyle(
  hostStyle: unknown
): boolean | undefined {
  if (typeof hostStyle !== "string") return undefined;
  // Own-property check: an unknown style colliding with an Object.prototype
  // key ("toString", "constructor", …) must read as undefined, not the
  // inherited value — resolveOpenAiCompatForHostConfig treats any non-undefined
  // preset as authoritative, so an inherited function would leak through.
  return Object.hasOwn(OPENAI_COMPAT_PRESET_BY_STYLE, hostStyle)
    ? OPENAI_COMPAT_PRESET_BY_STYLE[hostStyle]
    : undefined;
}

export function resolveOpenAiCompatForHostConfig(
  hostConfig: unknown,
  hostConfigOverride?: Record<string, unknown>
): boolean {
  const explicitOverride = readOpenAiCompatOverride(hostConfigOverride);
  if (explicitOverride !== undefined) return explicitOverride;

  const overridePreset = compatPresetForHostStyle(
    readHostStyle(hostConfigOverride)
  );
  if (overridePreset !== undefined) return overridePreset;

  const explicitBase = readOpenAiCompatOverride(hostConfig);
  if (explicitBase !== undefined) return explicitBase;

  return compatPresetForHostStyle(readHostStyle(hostConfig)) ?? false;
}
