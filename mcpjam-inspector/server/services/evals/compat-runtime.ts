import type { ConvexHttpClient } from "convex/browser";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readOpenAiCompatOverride(value: unknown): boolean | undefined {
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

function compatPresetForHostStyle(hostStyle: unknown): boolean | undefined {
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

export async function loadSuiteHostConfig(
  convexClient: ConvexHttpClient,
  suiteId?: string,
  namedHostId?: string,
): Promise<Record<string, unknown> | null> {
  if (namedHostId) {
    try {
      const host = await convexClient.query("hosts:getHost" as any, {
        hostId: namedHostId,
      });
      return isRecord(host?.config) ? host.config : null;
    } catch {
      return null;
    }
  }
  if (!suiteId) return null;
  try {
    const config = await convexClient.query(
      "hostConfigsV2:getSuiteConfig" as any,
      { suiteId },
    );
    return isRecord(config) ? config : null;
  } catch {
    return null;
  }
}
