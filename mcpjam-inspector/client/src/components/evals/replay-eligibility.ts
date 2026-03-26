import type { EvalSuiteRun } from "./types";

export type SuiteReplayEligibility = {
  hasServersConfigured: boolean;
  missingServers: string[];
  replayableLatestRun: EvalSuiteRun | null;
  canRunLive: boolean;
  canReplayFallback: boolean;
  canRunNow: boolean;
};

export function getSuiteReplayEligibility({
  suiteServers,
  connectedServerNames,
  latestRun,
}: {
  suiteServers?: string[];
  connectedServerNames?: Set<string>;
  latestRun?: EvalSuiteRun | null;
}): SuiteReplayEligibility {
  const normalizedSuiteServers = suiteServers ?? [];
  const hasServersConfigured = normalizedSuiteServers.length > 0;
  const missingServers =
    connectedServerNames && hasServersConfigured
      ? normalizedSuiteServers.filter(
          (serverName) => !connectedServerNames.has(serverName),
        )
      : [];
  const replayableLatestRun =
    latestRun?.hasServerReplayConfig === true ? latestRun : null;
  const canRunLive = hasServersConfigured && missingServers.length === 0;
  const canReplayFallback =
    hasServersConfigured &&
    missingServers.length > 0 &&
    replayableLatestRun !== null;

  return {
    hasServersConfigured,
    missingServers,
    replayableLatestRun,
    canRunLive,
    canReplayFallback,
    canRunNow: canRunLive || canReplayFallback,
  };
}
