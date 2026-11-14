/**
 * Which accounts an eval suite runs with, as the backend's
 * `testSuiteAccountSelections:getSuiteAccountsView` answers for the person
 * looking. Names never carry an email.
 */
export type SuiteAccount = {
  connectionId: string;
  name: string;
  isDefault: boolean;
  needsReauth: boolean;
};

/**
 * `accounts`: the person's own accounts, one or more of which they choose.
 * `shared`: the project's accounts on a server shared with the project, which
 * each member chooses among the same way. `xaa`: a simulated identity.
 * `none`: nothing to choose, so the server is not listed.
 */
export type SuiteAccountsMode = "accounts" | "shared" | "xaa" | "none";

export type SuiteAccountsServer = {
  serverId: string;
  mode: SuiteAccountsMode;
  accounts: SuiteAccount[];
  /** The saved choice; `null` (or empty) runs with the default account. */
  chosen: string[] | null;
  xaaSubject?: string;
};

export type SuiteAccountsScheduleOwner = {
  name: string;
  servers: Array<{ serverId: string; accountNames: string[] }>;
};

export type SuiteAccountsView = {
  servers: SuiteAccountsServer[];
  scheduleOwners: SuiteAccountsScheduleOwner[];
};

/** Whether the person chooses which of this server's accounts their runs use. */
export function choosesAccounts(server: SuiteAccountsServer): boolean {
  return server.mode === "accounts" || server.mode === "shared";
}

export const SUITE_ACCOUNTS_VIEW_QUERY =
  "testSuiteAccountSelections:getSuiteAccountsView";
export const SET_SUITE_ACCOUNT_SELECTION_MUTATION =
  "testSuiteAccountSelections:setSuiteAccountSelection";

/**
 * The accounts a server runs with: the saved choice, else the default. An id
 * that is no longer in `accounts` was removed, so it is left out here and
 * reported by {@link chosenAccountProblems} instead.
 */
export function checkedAccountIds(server: SuiteAccountsServer): string[] {
  if (server.chosen?.length) {
    const listed = new Set(server.accounts.map((a) => a.connectionId));
    return server.chosen.filter((id) => listed.has(id));
  }
  const fallback =
    server.accounts.find((account) => account.isDefault) ?? server.accounts[0];
  return fallback ? [fallback.connectionId] : [];
}

export type AccountProblem =
  | {
      kind: "needs_reconnect";
      serverId: string;
      serverName: string;
      connectionId: string;
      accountName: string;
    }
  | { kind: "removed"; serverId: string; serverName: string };

/**
 * Saved choices a launch would refuse. Only a saved choice is checked: a
 * suite nobody chose accounts for runs as it did before this feature, and
 * the backend never falls back from a choice to another account.
 */
export function chosenAccountProblems(
  view: SuiteAccountsView,
  serverName: (serverId: string) => string,
): AccountProblem[] {
  const problems: AccountProblem[] = [];
  for (const server of view.servers) {
    if (!choosesAccounts(server) || !server.chosen?.length) continue;
    const name = serverName(server.serverId);
    const byId = new Map(server.accounts.map((a) => [a.connectionId, a]));
    if (server.chosen.some((id) => !byId.has(id))) {
      problems.push({
        kind: "removed",
        serverId: server.serverId,
        serverName: name,
      });
    }
    for (const id of server.chosen) {
      const account = byId.get(id);
      if (!account?.needsReauth) continue;
      problems.push({
        kind: "needs_reconnect",
        serverId: server.serverId,
        serverName: name,
        connectionId: id,
        accountName: account.name,
      });
    }
  }
  return problems;
}

export type RunsAsEntry = {
  serverId: string;
  serverName: string;
  accounts: Array<{ name: string; needsReauth: boolean }>;
};

/**
 * "Runs as you": each server the person chooses accounts for, with the
 * accounts their runs use there.
 */
export function runsAsEntries(
  view: SuiteAccountsView,
  serverName: (serverId: string) => string,
): RunsAsEntry[] {
  return view.servers.flatMap((server) => {
    if (!choosesAccounts(server)) return [];
    const checked = new Set(checkedAccountIds(server));
    const accounts = server.accounts
      .filter((account) => checked.has(account.connectionId))
      .map(({ name, needsReauth }) => ({ name, needsReauth }));
    return accounts.length
      ? [{ serverId: server.serverId, serverName: serverName(server.serverId), accounts }]
      : [];
  });
}

/**
 * Project server ids for server refs that may be ids or names (a suite stores
 * names; an environment resolution may answer with either), in order, once.
 * A ref the project does not list is dropped: the view is keyed by id.
 */
export function serverIdsForRefs(
  refs: readonly string[],
  projectServers: readonly { _id: string; name: string }[] | undefined,
): string[] {
  const ids: string[] = [];
  for (const ref of refs) {
    const server = projectServers?.find(
      (candidate) => candidate._id === ref || candidate.name === ref,
    );
    if (server && !ids.includes(server._id)) ids.push(server._id);
  }
  return ids;
}
