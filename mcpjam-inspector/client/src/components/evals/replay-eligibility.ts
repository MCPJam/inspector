import type { EvalSuiteRun } from "./types";

export type SuiteReplayEligibility = {
  hasServersConfigured: boolean;
  missingServers: string[];
  replayableLatestRun: EvalSuiteRun | null;
  canRunLive: boolean;
  canReplayFallback: boolean;
  canRunNow: boolean;
};

/**
 * `suiteServers` is the EFFECTIVE server list — callers must pre-merge
 * legacy `suite.environment.servers` with `suite.hostAttachments[*].
 * resolvedServerNames` via {@link getEffectiveSuiteServers}. The helper
 * here doesn't introspect the suite shape so it stays focused on the
 * connection / replay decision.
 */
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
      : normalizedSuiteServers;
  const replayableLatestRun =
    latestRun?.hasServerReplayConfig === true ? latestRun : null;
  const canRunLive = hasServersConfigured && missingServers.length === 0;
  const canReplayFallback =
    replayableLatestRun !== null &&
    (!hasServersConfigured || missingServers.length > 0);

  return {
    hasServersConfigured,
    missingServers,
    replayableLatestRun,
    canRunLive,
    canReplayFallback,
    canRunNow: canRunLive || canReplayFallback,
  };
}
