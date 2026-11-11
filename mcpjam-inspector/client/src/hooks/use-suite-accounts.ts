import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useProjectServers, type RemoteServer } from "@/hooks/useProjects";
import { useSoftQuery } from "@/hooks/use-soft-query";
import { useEvalAccountSelectionEnabled } from "@/hooks/useEvalAccountSelectionEnabled";
import { getMcpServerDisplayName } from "@/lib/mcp-server-display-name";
import { getEffectiveSuiteServers } from "@/components/evals/helpers";
import type { EvalSuite } from "@/components/evals/types";
import {
  serverIdsForRefs,
  SUITE_ACCOUNTS_VIEW_QUERY,
  type SuiteAccountsView,
} from "@/lib/evals/eval-accounts";

export type SuiteAccountsViewState = {
  view: SuiteAccountsView | undefined;
  error: Error | undefined;
  /** Asked and not yet answered. False while the read is skipped. */
  loading: boolean;
};

/**
 * The person's accounts for these servers of a suite, read only while the
 * rollout flag is on.
 *
 * A soft read: a failure comes back as `error` instead of being thrown during
 * render, because the Setup Run sheet and the settings page must keep working
 * without it. The launch checks the same choice itself and refuses an account
 * that is unavailable.
 */
export function useSuiteAccountsView({
  suiteId,
  serverIds,
}: {
  suiteId: string | null | undefined;
  serverIds: readonly string[];
}): SuiteAccountsViewState {
  const enabled = useEvalAccountSelectionEnabled();
  const { isAuthenticated } = useConvexAuth();
  const isUserReady = useDbUserReady();
  const args =
    enabled && isAuthenticated && isUserReady && suiteId && serverIds.length
      ? { suiteId, serverIds: [...serverIds] }
      : "skip";
  const { data, error } = useSoftQuery<SuiteAccountsView>(
    SUITE_ACCOUNTS_VIEW_QUERY,
    args,
  );
  return { view: data, error, loading: args !== "skip" && !data && !error };
}

/** A project server's display name, from the project's own server list. */
export function serverNameFrom(
  projectServers: RemoteServer[] | undefined,
): (serverId: string) => string {
  return (serverId) =>
    getMcpServerDisplayName(serverId, { remoteServers: projectServers });
}

/**
 * {@link useSuiteAccountsView} for every server a suite's runs connect,
 * named. The same servers "Where it runs" lists: an environment suite's
 * environments' groups, or a legacy suite's own servers.
 */
export function useSuiteAccounts(
  suite: EvalSuite,
  projectId: string | null | undefined,
) {
  const { isAuthenticated } = useConvexAuth();
  const { servers: projectServers } = useProjectServers({
    projectId: projectId ?? null,
    isAuthenticated,
  });
  const serverIds = useMemo(
    () => serverIdsForRefs(getEffectiveSuiteServers(suite), projectServers),
    [suite, projectServers],
  );
  const state = useSuiteAccountsView({ suiteId: suite._id, serverIds });
  const serverName = useMemo(
    () => serverNameFrom(projectServers),
    [projectServers],
  );
  return {
    ...state,
    // Until the project's servers are read, no server id is known to ask with.
    loading: state.loading || projectServers === undefined,
    serverIds,
    serverName,
  };
}
