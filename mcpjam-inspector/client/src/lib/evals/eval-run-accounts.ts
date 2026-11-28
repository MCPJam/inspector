import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { EvalRunAccount } from "@/components/evals/types";

/** The name an account had when the run started; an XAA identity by its subject. */
export function runAccountName(account: EvalRunAccount): string {
  return (account.kind === "xaa" && account.xaaSubject?.trim()) || account.name;
}

/** Whether these runs, taken together, used more than one account. */
export function runsUsedSeveralAccounts(
  runs: ReadonlyArray<{ accountsAtRun?: readonly EvalRunAccount[] }>,
): boolean {
  const seen = new Set<string>();
  for (const run of runs) {
    for (const account of run.accountsAtRun ?? []) {
      seen.add(`${account.serverId}\u0000${runAccountName(account)}`);
      if (seen.size > 1) return true;
    }
  }
  return false;
}

/** A run's accounts grouped by server, in recorded order, each name once. */
export function runAccountsByServer(
  accounts: readonly EvalRunAccount[],
): Array<{ serverId: string; names: string[] }> {
  const groups: Array<{ serverId: string; names: string[] }> = [];
  for (const account of accounts) {
    const name = runAccountName(account);
    const group = groups.find((item) => item.serverId === account.serverId);
    if (!group) groups.push({ serverId: account.serverId, names: [name] });
    else if (!group.names.includes(name)) group.names.push(name);
  }
  return groups;
}

/**
 * The account one tool call ran on. A span names its account by connection
 * id; a span without one (a call recorded before spans carried it) is still
 * unambiguous when the run had exactly one account for that server.
 */
export function spanAccountName(
  span: Pick<EvalTraceSpan, "category" | "connectionId" | "serverId">,
  accounts: readonly EvalRunAccount[] | undefined,
): string | undefined {
  if (span.category !== "tool" || !accounts?.length) return undefined;
  if (span.connectionId) {
    const account = accounts.find((a) => a.connectionId === span.connectionId);
    return account ? runAccountName(account) : undefined;
  }
  const onServer = span.serverId
    ? accounts.filter((a) => a.serverId === span.serverId)
    : [];
  return onServer.length === 1 ? runAccountName(onServer[0]) : undefined;
}

/** {@link spanAccountName} for every tool call in a trace, by tool call id. */
export function toolCallAccountNames(
  spans: readonly EvalTraceSpan[] | undefined,
  accounts: readonly EvalRunAccount[] | undefined,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const span of spans ?? []) {
    const name = span.toolCallId ? spanAccountName(span, accounts) : undefined;
    if (span.toolCallId && name) names.set(span.toolCallId, name);
  }
  return names;
}
