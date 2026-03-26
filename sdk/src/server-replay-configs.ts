import type { MCPServerReplayConfig } from "./eval-reporting-types.js";

type ReplayConfigProvider = {
  getServerReplayConfigs?: () => MCPServerReplayConfig[] | undefined;
};

type ReplayConfigSourceInput = {
  serverReplayConfigs?: MCPServerReplayConfig[];
  serverNames?: string[];
  agent?: unknown;
  mcpClientManager?: unknown;
};

function filterReplayConfigs(
  replayConfigs: MCPServerReplayConfig[],
  serverNames: string[] | undefined
): MCPServerReplayConfig[] | undefined {
  if (!Array.isArray(serverNames) || serverNames.length === 0) {
    return replayConfigs;
  }

  const allowedServerNames = new Set(
    serverNames
      .map((serverName) => serverName.trim())
      .filter((serverName) => serverName.length > 0)
  );
  if (allowedServerNames.size === 0) {
    return replayConfigs;
  }

  const filteredReplayConfigs = replayConfigs.filter((config) =>
    allowedServerNames.has(config.serverId)
  );
  return filteredReplayConfigs.length > 0 ? filteredReplayConfigs : undefined;
}

function getReplayConfigs(
  source: unknown,
  serverNames: string[] | undefined
): MCPServerReplayConfig[] | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const getServerReplayConfigs = (source as ReplayConfigProvider)
    .getServerReplayConfigs;
  if (typeof getServerReplayConfigs !== "function") {
    return undefined;
  }

  const replayConfigs = getServerReplayConfigs.call(source);
  return Array.isArray(replayConfigs) && replayConfigs.length > 0
    ? filterReplayConfigs(replayConfigs, serverNames)
    : undefined;
}

export function resolveServerReplayConfigs(
  input: ReplayConfigSourceInput
): MCPServerReplayConfig[] | undefined {
  if (input.serverReplayConfigs !== undefined) {
    return input.serverReplayConfigs;
  }

  const agentReplayConfigs = getReplayConfigs(input.agent, input.serverNames);
  if (agentReplayConfigs) {
    return agentReplayConfigs;
  }

  return getReplayConfigs(input.mcpClientManager, input.serverNames);
}
