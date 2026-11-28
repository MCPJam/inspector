import { useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { TableCell } from "@mcpjam/design-system/table";
import { useProjectServers } from "@/hooks/useProjects";
import { serverNameFrom } from "@/hooks/use-suite-accounts";
import {
  runAccountName,
  runAccountsByServer,
} from "@/lib/evals/eval-run-accounts";
import { runAccountCredentialFacts } from "@/lib/evals/run-account-credentials";
import type { EvalRunAccount, EvalSuiteRunListItem } from "../evals/types";
import { AccountName } from "./suite-runs-as";
import { Fact } from "./run-launch-context";

type RunAccountsRecord = Pick<EvalSuiteRunListItem, "projectId" | "accountsAtRun">;

type LaunchAccounts = {
  projectId?: string;
  accounts: EvalRunAccount[];
};

/**
 * The accounts a launch ran with. One launch can fan out into a run per
 * environment, each recording the servers it connected. `null` when none did:
 * a run from before accounts were recorded.
 */
export function launchAccounts(
  runs: readonly RunAccountsRecord[],
): LaunchAccounts | null {
  const recorded = runs.filter((run) => run.accountsAtRun?.length);
  if (!recorded.length) return null;
  const first = recorded[0];
  return {
    projectId: first.projectId,
    accounts: recorded.flatMap((run) => run.accountsAtRun ?? []),
  };
}

function useServerName(projectId: string | undefined) {
  const { isAuthenticated } = useConvexAuth();
  const { servers } = useProjectServers({
    projectId: projectId ?? null,
    isAuthenticated,
  });
  return useMemo(() => serverNameFrom(servers), [servers]);
}

/** One account's server, when worth naming, then its token facts. */
function accountTitle(
  accounts: readonly EvalRunAccount[],
  serverId: string,
  name: string,
  serverLabel: string | undefined,
): string | undefined {
  const facts = accounts
    .filter(
      (account) =>
        account.serverId === serverId && runAccountName(account) === name,
    )
    .flatMap((account) => runAccountCredentialFacts(account));
  const lines = [...(serverLabel ? [serverLabel] : []), ...new Set(facts)];
  return lines.length ? lines.join(" · ") : undefined;
}

/**
 * "[W] Work [P] Personal": each account the run used, once. Hovering one
 * shows its token facts, and its server when `serverName` is given.
 */
function AccountList({
  accounts,
  serverName,
}: {
  accounts: readonly EvalRunAccount[];
  serverName?: (serverId: string) => string;
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {runAccountsByServer(accounts).flatMap((group) =>
        group.names.map((name) => (
          <span
            key={`${group.serverId}:${name}`}
            title={accountTitle(
              accounts,
              group.serverId,
              name,
              serverName?.(group.serverId),
            )}
            data-testid="run-account-name"
          >
            <AccountName name={name} />
          </span>
        )),
      )}
    </span>
  );
}

/**
 * The run header's "Ran as" fact: the accounts the run used. The page names
 * the servers after it. Nothing for a run that recorded no accounts, so older
 * runs keep the header they had.
 */
export function RunAccountFacts({
  runs,
}: {
  runs: readonly RunAccountsRecord[];
}) {
  const launch = launchAccounts(runs);
  return launch ? <LoadedRunAccountFacts launch={launch} /> : null;
}

function LoadedRunAccountFacts({ launch }: { launch: LaunchAccounts }) {
  const serverName = useServerName(launch.projectId);
  const severalServers = runAccountsByServer(launch.accounts).length > 1;
  return (
    <dl
      className="flex min-w-0 items-baseline"
      data-testid="evaluate-run-account-facts"
    >
      <Fact label="Ran as">
        <AccountList
          accounts={launch.accounts}
          serverName={severalServers ? serverName : undefined}
        />
      </Fact>
    </dl>
  );
}

/**
 * The "Account" cell of one Recent runs row: the account names only, or a
 * dash for a launch that recorded no accounts.
 */
export function RunAccountCells({
  runs,
}: {
  runs: readonly RunAccountsRecord[];
}) {
  const launch = launchAccounts(runs);
  if (!launch) {
    return <TableCell className="text-muted-foreground">—</TableCell>;
  }
  return (
    <TableCell className="max-w-64" data-testid="run-history-account">
      <AccountList accounts={launch.accounts} />
    </TableCell>
  );
}
