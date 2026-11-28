import { Fragment, useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { Badge } from "@mcpjam/design-system/badge";
import { TableCell } from "@mcpjam/design-system/table";
import { useProjectServers } from "@/hooks/useProjects";
import { serverNameFrom } from "@/hooks/use-suite-accounts";
import {
  ranAsRole,
  runAccountName,
  runAccountsByServer,
} from "@/lib/evals/eval-run-accounts";
import { runAccountCredentialFacts } from "@/lib/evals/run-account-credentials";
import type { EvalRunAccount, EvalSuiteRunListItem } from "../evals/types";
import { ServerLabel } from "../evals/account-picker";
import { AccountName } from "./suite-runs-as";
import { Fact } from "./run-launch-context";

type RunAccountsRecord = Pick<
  EvalSuiteRunListItem,
  "projectId" | "source" | "accountsAtRun" | "ranAsName"
>;

type LaunchAccounts = {
  projectId?: string;
  ranAsName?: string;
  role: ReturnType<typeof ranAsRole>;
  accounts: EvalRunAccount[];
};

/**
 * Whose accounts a launch ran with, and which. One launch can fan out into a
 * run per environment, each recording the servers it connected; they share a
 * launcher, so the person comes from the first run that recorded accounts.
 * `null` when none did: a run from before accounts were recorded.
 */
export function launchAccounts(
  runs: readonly RunAccountsRecord[],
): LaunchAccounts | null {
  const recorded = runs.filter((run) => run.accountsAtRun?.length);
  if (!recorded.length) return null;
  const first = recorded[0];
  return {
    projectId: first.projectId,
    ranAsName: first.ranAsName,
    role: ranAsRole(first.source),
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

/**
 * Why the run ran as this person, after their name. The leading space keeps
 * the name and the tag apart when the cell is read aloud or copied.
 */
function RoleTag({ role }: { role: string | null }) {
  if (!role) return null;
  return (
    <>
      {" "}
      <Badge
        variant="outline"
        className="px-1.5 py-0 align-middle text-[10px] font-normal text-muted-foreground"
      >
        {role}
      </Badge>
    </>
  );
}

/** One account's token facts, for its hover title. */
function accountTitle(
  accounts: readonly EvalRunAccount[],
  serverId: string,
  name: string,
): string | undefined {
  const facts = accounts
    .filter(
      (account) =>
        account.serverId === serverId && runAccountName(account) === name,
    )
    .flatMap((account) => runAccountCredentialFacts(account));
  return facts.length ? [...new Set(facts)].join(" · ") : undefined;
}

/**
 * "[W] Work [P] Personal · [server] Mail": each server's accounts, then the
 * server. Each account's token facts show on hover.
 */
function AccountList({
  accounts,
  serverName,
}: {
  accounts: readonly EvalRunAccount[];
  serverName: (serverId: string) => string;
}) {
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {runAccountsByServer(accounts).map((group, index) => (
        <Fragment key={group.serverId}>
          {index > 0 ? (
            <span aria-hidden className="text-muted-foreground">
              ·
            </span>
          ) : null}
          {group.names.map((name) => (
            <span
              key={name}
              title={accountTitle(accounts, group.serverId, name)}
              data-testid="run-account-name"
            >
              <AccountName name={name} />
            </span>
          ))}
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          <ServerLabel name={serverName(group.serverId)} />
        </Fragment>
      ))}
    </span>
  );
}

/** "by Ana Ruiz (Schedule owner)": who started the run. */
function Launcher({ launch }: { launch: LaunchAccounts }) {
  if (!launch.ranAsName) return null;
  return (
    <span
      className="text-[12.5px] text-muted-foreground"
      data-testid="run-account-launcher"
    >
      by {launch.ranAsName}
      <RoleTag role={launch.role} />
    </span>
  );
}

/**
 * The run header's "Ran as" fact: the accounts the run used, then who
 * started it. Nothing for a run that recorded no accounts, so older runs keep
 * the header they had.
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
  return (
    <div
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1"
      data-testid="evaluate-run-account-facts"
    >
      <dl className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
        <Fact label="Ran as">
          <AccountList accounts={launch.accounts} serverName={serverName} />
        </Fact>
      </dl>
      <Launcher launch={launch} />
    </div>
  );
}

/**
 * The "Ran as" and "By" cells of one Recent runs row: a dash in each
 * for a launch that recorded no accounts.
 */
export function RunAccountCells({
  runs,
}: {
  runs: readonly RunAccountsRecord[];
}) {
  const launch = launchAccounts(runs);
  if (!launch) {
    return (
      <>
        <TableCell className="text-muted-foreground">—</TableCell>
        <TableCell className="text-muted-foreground">—</TableCell>
      </>
    );
  }
  return <LoadedRunAccountCells launch={launch} />;
}

function LoadedRunAccountCells({ launch }: { launch: LaunchAccounts }) {
  const serverName = useServerName(launch.projectId);
  return (
    <>
      <TableCell className="max-w-64" data-testid="run-history-ran-as">
        <AccountList accounts={launch.accounts} serverName={serverName} />
      </TableCell>
      <TableCell className="whitespace-nowrap" data-testid="run-history-by">
        {launch.ranAsName ? (
          <>
            {launch.ranAsName}
            <RoleTag role={launch.role} />
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </>
  );
}
