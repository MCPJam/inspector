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

/**
 * "Linear · test-automation-1 · Uploaded Nov 17, 10:27 AM by Ana Ruiz ·
 * Expires Nov 17, 11:27 AM": one line per account whose token's facts the
 * run recorded. Empty for runs recorded before them.
 */
function credentialLines(
  accounts: readonly EvalRunAccount[],
  serverName: (serverId: string) => string,
): string[] {
  return accounts.flatMap((account) => {
    const facts = runAccountCredentialFacts(account);
    return facts.length
      ? [
          [serverName(account.serverId), runAccountName(account), ...facts].join(
            " · ",
          ),
        ]
      : [];
  });
}

/** "Asana Dummy, Live · Linear Work": each server, then the accounts it ran with. */
function AccountList({
  accounts,
  serverName,
  credentials = false,
}: {
  accounts: readonly EvalRunAccount[];
  serverName: (serverId: string) => string;
  /** One line per account with its token's facts, instead of names alone. */
  credentials?: boolean;
}) {
  if (credentials) {
    return (
      <>
        {credentialLines(accounts, serverName).map((line, index) => (
          <span key={index} className="block truncate" title={line}>
            {line}
          </span>
        ))}
      </>
    );
  }
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
  const hasCredentials =
    credentialLines(launch.accounts, serverName).length > 0;
  return (
    <dl
      className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1"
      data-testid="evaluate-run-account-facts"
    >
      {launch.ranAsName ? (
        <Fact label={launch.accounts.some((account) => account.cases?.length) ? "Started by" : "Ran as"}>
          {launch.ranAsName}
          <RoleTag role={launch.role} />
        </Fact>
      ) : null}
      <Fact label="Accounts">
        <AccountList accounts={launch.accounts} serverName={serverName} />
      </Fact>
      {hasCredentials ? (
        <Fact label="Credentials">
          <div data-testid="evaluate-run-account-credentials">
            <AccountList
              accounts={launch.accounts}
              serverName={serverName}
              credentials
            />
          </div>
        </Fact>
      ) : null}
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
      <TableCell
        className="max-w-64"
        data-testid="run-history-accounts"
        title={credentialLines(launch.accounts, serverName).join("\n") || undefined}
      >
        <AccountList accounts={launch.accounts} serverName={serverName} />
      </TableCell>
    </>
  );
}
