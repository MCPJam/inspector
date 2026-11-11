import { Fragment, useMemo } from "react";
import { useConvexAuth } from "convex/react";
import { Badge } from "@mcpjam/design-system/badge";
import { TableCell } from "@mcpjam/design-system/table";
import { useProjectServers } from "@/hooks/useProjects";
import { serverNameFrom } from "@/hooks/use-suite-accounts";
import {
  ranAsRole,
  runAccountsByServer,
} from "@/lib/evals/eval-run-accounts";
import type { EvalRunAccount, EvalSuiteRunListItem } from "../evals/types";
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

/** "Asana Dummy, Live · Linear Work": each server, then the accounts it ran with. */
function AccountList({
  accounts,
  serverName,
}: {
  accounts: readonly EvalRunAccount[];
  serverName: (serverId: string) => string;
}) {
  return (
    <>
      {runAccountsByServer(accounts).map((group, index) => (
        <Fragment key={group.serverId}>
          {index > 0 ? <span aria-hidden> · </span> : null}
          <span className="text-muted-foreground">
            {serverName(group.serverId)}
          </span>{" "}
          <span>{group.names.join(", ")}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * The run header's "Ran as" and "Accounts" facts. Nothing for a run that
 * recorded no accounts, so older runs keep the header they had.
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
    <dl
      className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1"
      data-testid="evaluate-run-account-facts"
    >
      {launch.ranAsName ? (
        <Fact label="Ran as">
          {launch.ranAsName}
          <RoleTag role={launch.role} />
        </Fact>
      ) : null}
      <Fact label="Accounts">
        <AccountList accounts={launch.accounts} serverName={serverName} />
      </Fact>
    </dl>
  );
}

/**
 * The "Ran as" and "Accounts" cells of one Recent runs row: a dash in each
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
      <TableCell className="whitespace-nowrap" data-testid="run-history-ran-as">
        {launch.ranAsName ? (
          <>
            {launch.ranAsName}
            <RoleTag role={launch.role} />
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="max-w-64" data-testid="run-history-accounts">
        <AccountList accounts={launch.accounts} serverName={serverName} />
      </TableCell>
    </>
  );
}
