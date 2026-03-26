import type { MCPServerReplayConfig } from "./eval-reporting-types.js";

type ReplayConfigProvider = {
  getServerReplayConfigs?: () => MCPServerReplayConfig[] | undefined;
};

type ReplayConfigSourceInput = {
  serverReplayConfigs?: MCPServerReplayConfig[];
  agent?: unknown;
  mcpClientManager?: unknown;
};

function getReplayConfigs(source: unknown): MCPServerReplayConfig[] | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const getServerReplayConfigs = (
    source as ReplayConfigProvider
  ).getServerReplayConfigs;
  if (typeof getServerReplayConfigs !== "function") {
    return undefined;
  }

  const replayConfigs = getServerReplayConfigs.call(source);
  return Array.isArray(replayConfigs) && replayConfigs.length > 0
    ? replayConfigs
    : undefined;
}

export function resolveServerReplayConfigs(
  input: ReplayConfigSourceInput
): MCPServerReplayConfig[] | undefined {
  if (input.serverReplayConfigs !== undefined) {
    return input.serverReplayConfigs;
  }

  const agentReplayConfigs = getReplayConfigs(input.agent);
  if (agentReplayConfigs) {
    return agentReplayConfigs;
  }

  return getReplayConfigs(input.mcpClientManager);
}
