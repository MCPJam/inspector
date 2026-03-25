import type { EvalAgent } from "./EvalAgent.js";
import type {
  MCPJamReportingConfig,
  MCPServerReplayConfig,
} from "./eval-reporting-types.js";

type ReplayAwareAgent = EvalAgent & {
  getServerReplayConfigs?: () => MCPServerReplayConfig[] | undefined;
};

export function resolveServerReplayConfigs(
  agent: EvalAgent,
  config?: MCPJamReportingConfig
): MCPServerReplayConfig[] | undefined {
  if (config?.serverReplayConfigs !== undefined) {
    return config.serverReplayConfigs;
  }

  const getServerReplayConfigs = (agent as ReplayAwareAgent)
    .getServerReplayConfigs;
  if (typeof getServerReplayConfigs !== "function") {
    return undefined;
  }

  const replayConfigs = getServerReplayConfigs.call(agent);
  return Array.isArray(replayConfigs) && replayConfigs.length > 0
    ? replayConfigs
    : undefined;
}
