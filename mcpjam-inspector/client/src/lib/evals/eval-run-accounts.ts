import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { EvalRunAccount, EvalSuiteRun } from "@/components/evals/types";

/**
 * Why a run ran as someone other than whoever opened it: a schedule runs as
 * its owner, and an API, CLI or SDK launch as the owner of the key it used.
 */
export function ranAsRole(
  source: EvalSuiteRun["source"],
): "Schedule owner" | "Key owner" | null {
  if (source === "schedule") return "Schedule owner";
  if (source === "api" || source === "sdk") return "Key owner";
  return null;
}

/** The name an account had when the run started; an XAA identity by its subject. */
export function runAccountName(account: EvalRunAccount): string {
  return (account.kind === "xaa" && account.xaaSubject?.trim()) || account.name;
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
