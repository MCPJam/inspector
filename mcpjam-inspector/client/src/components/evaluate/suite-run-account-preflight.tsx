import { useMemo } from "react";
import { Button } from "@mcpjam/design-system/button";
import { buildProjectServerPath, navigateApp } from "@/lib/app-navigation";
import type { RemoteServer } from "@/hooks/useProjects";
import { serverNameFrom, useSuiteAccountsView } from "@/hooks/use-suite-accounts";
import {
  chosenAccountProblems,
  runsAsEntries,
  serverIdsForRefs,
  type AccountProblem,
  type RunsAsEntry,
} from "@/lib/evals/eval-accounts";
import { getEffectiveSuiteServers } from "../evals/helpers";
import type { EvalSuite } from "../evals/types";

/** The account half of the Setup Run preflight. Each field is absent until there is something to say. */
export type AccountPreflight = {
  /** Chosen accounts the launch would refuse: removed, or needing reconnect. */
  accountProblems?: AccountProblem[];
  /** The person's own accounts the run will use. */
  runsAs?: RunsAsEntry[];
};

/**
 * {@link AccountPreflight} for a suite, read for the same servers its
 * Accounts settings row lists, so the sheet and the row never disagree about
 * which accounts exist.
 *
 * `useSuiteRunPreflight` calls this before its environment resolutions. That
 * read is the last one a render makes, and tests read the environments it
 * asked for from the last call.
 */
export function useSuiteAccountPreflight({
  suite,
  projectServers,
}: {
  suite: EvalSuite;
  /** The project's servers, as the preflight already read them. */
  projectServers: RemoteServer[] | undefined;
}): AccountPreflight {
  const serverIds = useMemo(
    () => serverIdsForRefs(getEffectiveSuiteServers(suite), projectServers),
    [suite, projectServers],
  );
  const { view } = useSuiteAccountsView({ suiteId: suite._id, serverIds });
  return useMemo(() => {
    if (!view) return {};
    const serverName = serverNameFrom(projectServers);
    const accountProblems = chosenAccountProblems(view, serverName);
    return {
      ...(accountProblems.length ? { accountProblems } : {}),
      runsAs: runsAsEntries(view, serverName),
    };
  }, [view, projectServers]);
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
