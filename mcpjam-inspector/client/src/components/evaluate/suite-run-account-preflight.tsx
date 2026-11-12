import { useMemo } from "react";
import { Button } from "@mcpjam/design-system/button";
import { buildProjectServerPath, navigateApp } from "@/lib/app-navigation";
import type { RemoteServer } from "@/hooks/useProjects";
import {
  serverNameFrom,
  useSuiteAccountsView,
} from "@/hooks/use-suite-accounts";
import {
  chosenAccountProblems,
  runsAsEntries,
  serverIdsForRefs,
  type AccountProblem,
  type RunsAsEntry,
} from "@/lib/evals/eval-accounts";
import {
  buildSuiteHostRunPlans,
  getEffectiveSuiteServers,
} from "../evals/helpers";
import type { EvalSuite } from "../evals/types";

/** The account half of the Setup Run preflight. Each field is absent until there is something to say. */
export type AccountPreflight = {
  /** Chosen accounts the launch would refuse: removed, or needing reconnect. */
  accountProblems?: AccountProblem[];
  /** The person's own accounts the run will use. */
  runsAs?: RunsAsEntry[];
  /** Both, for only the servers these refs (ids or names) name. */
  accountsFor?: (
    refs: readonly string[],
  ) => Pick<AccountPreflight, "accountProblems" | "runsAs">;
};

/**
 * {@link AccountPreflight} for a suite, read for the same servers its
 * Accounts settings row lists, so the sheet and the row never disagree about
 * which accounts exist. A planned launch counts only the servers it connects.
 *
 * `useSuiteRunPreflight` calls this before its environment resolutions. That
 * read is the last one a render makes, and tests read the environments it
 * asked for from the last call.
 */
export function useSuiteAccountPreflight({
  suite,
  projectServers,
  planned,
}: {
  suite: EvalSuite;
  /** The project's servers, as the preflight already read them. */
  projectServers: RemoteServer[] | undefined;
  planned?: {
    environmentIds: readonly string[];
    serverRefs?: readonly string[];
  };
}): AccountPreflight {
  const serverIds = useMemo(
    () => serverIdsForRefs(getEffectiveSuiteServers(suite), projectServers),
    [suite, projectServers],
  );
  const { view } = useSuiteAccountsView({ suiteId: suite._id, serverIds });
  if (!view) return {};
  const serverName = serverNameFrom(projectServers);
  const accountsFor = (refs: readonly string[]) => {
    const ids = new Set(serverIdsForRefs(refs, projectServers));
    const kept = {
      ...view,
      servers: view.servers.filter((s) => ids.has(s.serverId)),
    };
    const accountProblems = chosenAccountProblems(kept, serverName);
    return {
      ...(accountProblems.length ? { accountProblems } : {}),
      runsAs: runsAsEntries(kept, serverName),
    };
  };
  const plannedRefs =
    planned &&
    (planned.serverRefs ??
      environmentServerRefs(suite, planned.environmentIds));
  return { ...accountsFor(plannedRefs ?? serverIds), accountsFor };
}

/**
 * The servers these environments connect, from the suite's list of its own.
 * Unknown when none is given or one isn't listed, so nothing is left out.
 */
function environmentServerRefs(
  suite: EvalSuite,
  environmentIds: readonly string[],
): string[] | undefined {
  const targets = environmentIds.map((id) =>
    suite.environmentTargets?.find((target) => target.environmentId === id),
  );
  if (!targets.length || !targets.every(Boolean)) return undefined;
  return targets.flatMap((target) => target?.serverNames ?? []);
}

/**
 * The account checks for only the clients or environments picked in the
 * sheet: a problem on a server that only an unpicked one uses doesn't stop
 * the run, and its accounts aren't ones the run uses.
 */
export function scopeAccountPreflight<T extends AccountPreflight>(
  preflight: T,
  suite: EvalSuite,
  selectedIds: readonly string[],
): T {
  const refs = suite.environmentIds?.length
    ? environmentServerRefs(suite, selectedIds)
    : suite.hostAttachments?.length
      ? // The launch's own per-client plans: a client with servers of its
        // own runs on those alone, not the suite's legacy list.
        buildSuiteHostRunPlans(suite)
          .filter(
            (plan) =>
              plan.namedHostId !== undefined &&
              selectedIds.includes(plan.namedHostId),
          )
          .flatMap((plan) => plan.serverIds)
      : undefined;
  if (!refs || !preflight.accountsFor) return preflight;
  const { accountProblems, runsAs } = preflight.accountsFor(refs);
  return { ...preflight, accountProblems, runsAs };
}

/**
 * One line per chosen account the launch would refuse. Start stays off while
 * any is listed (`hasBlockingPreflight`): a run never swaps in an account
 * nobody chose.
 */
export function AccountPreflightNotices({
  preflight,
  disabled = false,
  onEditSettings,
}: {
  preflight: AccountPreflight;
  disabled?: boolean;
  /** Where a removed account is chosen again. */
  onEditSettings?: () => void;
}) {
  const problems = preflight.accountProblems ?? [];
  if (!problems.length) return null;
  return (
    <div className="space-y-2" data-testid="preflight-account-problems">
      {problems.map((problem) =>
        problem.kind === "needs_reconnect" ? (
          <div
            key={`reconnect:${problem.connectionId}`}
            className="flex items-center gap-2"
          >
            <p className="min-w-0 flex-1 text-destructive">
              {problem.serverName} {problem.accountName} needs reconnect.
            </p>
            <Button
              variant="secondary"
              size="sm"
              disabled={disabled}
              aria-label={`Reconnect ${problem.serverName} ${problem.accountName}`}
              // The server's own page, where its Authorization tab lists the
              // account and reconnects it.
              onClick={() =>
                navigateApp(buildProjectServerPath(problem.serverId))
              }
            >
              Reconnect
            </Button>
          </div>
        ) : (
          <p key={`removed:${problem.serverId}`} className="text-destructive">
            An account chosen for {problem.serverName} was removed. Choose again
            in the suite's settings.{" "}
            {onEditSettings ? (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                disabled={disabled}
                onClick={onEditSettings}
              >
                Open suite settings
              </Button>
            ) : null}
          </p>
        ),
      )}
    </div>
  );
}
