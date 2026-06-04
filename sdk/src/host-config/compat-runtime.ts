/**
 * OpenAI Apps compat resolution from a hostConfig (+ optional override).
 *
 * Pure — no Convex / Node / ai-sdk imports. The eval runner uses this to
 * decide whether to inject the OpenAI Apps compat shim into widget HTML
 * snapshots for hosts that emulate ChatGPT-style apps.
 *
 * Resolution order (first match wins):
 *   1. Explicit override on `hostConfigOverride.mcpProfile.apps.compatRuntime.openaiApps`
 *   2. Host-style preset from `hostConfigOverride.hostStyle`
 *   3. Explicit base on `hostConfig.mcpProfile.apps.compatRuntime.openaiApps`
 *   4. Host-style preset from `hostConfig.hostStyle` (defaults to `false`)
 *
 * Style presets:
 *   - "chatgpt" | "copilot" | "mcpjam" → true
 *   - "claude"  | "cursor"  | "codex"  → false
 *   - anything else → undefined (falls through; ultimate default is false)
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readOpenAiCompatOverride(value: unknown): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const profile = isRecord(value.mcpProfile) ? value.mcpProfile : undefined;
  const apps = isRecord(profile?.apps) ? profile.apps : undefined;
  const compatRuntime = isRecord(apps?.compatRuntime)
    ? apps.compatRuntime
    : undefined;
  return typeof compatRuntime?.openaiApps === "boolean"
    ? compatRuntime.openaiApps
    : undefined;
}

export function compatPresetForHostStyle(
  hostStyle: unknown,
): boolean | undefined {
  switch (hostStyle) {
    case "chatgpt":
    case "copilot":
    case "mcpjam":
      return true;
    case "claude":
    case "cursor":
    case "codex":
      return false;
    default:
      return undefined;
  }
}

export function resolveOpenAiCompatForHostConfig(
  hostConfig: unknown,
  hostConfigOverride?: Record<string, unknown>,
): boolean {
  const explicitOverride = readOpenAiCompatOverride(hostConfigOverride);
  if (explicitOverride !== undefined) return explicitOverride;

  const overridePreset = compatPresetForHostStyle(
    hostConfigOverride?.hostStyle,
  );
  if (overridePreset !== undefined) return overridePreset;

  const explicitBase = readOpenAiCompatOverride(hostConfig);
  if (explicitBase !== undefined) return explicitBase;

  return (
    compatPresetForHostStyle(
      isRecord(hostConfig) ? hostConfig.hostStyle : undefined,
    ) ?? false
  );
}
