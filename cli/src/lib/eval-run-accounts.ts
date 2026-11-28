/**
 * The human-format account lines for eval runs: one line per server, naming
 * the accounts the runs used there. `--format json` prints nothing here, so
 * its output stays one document; the full `accounts` list is in it already.
 */
import type {
  PlatformApiClient,
  PlatformEvalRun,
  PlatformEvalRunAccount,
} from "@mcpjam/sdk/platform";
import { sanitizeTerminalText } from "./mrtr-input.js";

type RunWithAccounts = Pick<PlatformEvalRun, "accounts">;

const KIND_LABELS: Readonly<Record<string, string>> = {
  personal: "personal",
  project: "project",
  xaa: "XAA",
};

function recordedAccounts(
  runs: readonly RunWithAccounts[]
): PlatformEvalRunAccount[] {
  return runs.flatMap((run) => run.accounts ?? []);
}

/**
 * Server names by id, for the lines. Asked for only when a person reads the
 * output and a run recorded an account. Empty when the read fails, and the
 * lines then name servers by id.
 */
export async function runAccountServerNames(
  client: Pick<PlatformApiClient, "listProjectServers">,
  signal: AbortSignal,
  projectId: string,
  runs: readonly RunWithAccounts[],
  format: string
): Promise<ReadonlyMap<string, string>> {
  if (format !== "human" || recordedAccounts(runs).length === 0) {
    return new Map();
  }
  try {
    const servers = await client.listProjectServers({ projectId }, { signal });
    return new Map(servers.items.map((server) => [server.id, server.name]));
  } catch {
    // The lines follow a command that already succeeded and must not fail it.
    return new Map();
  }
}

/** "test-automation-1 (personal, qa@example.com)". */
function accountText(account: PlatformEvalRunAccount): string {
  const identity = account.identity;
  const who =
    identity?.email ??
    (identity?.name && identity.name !== account.name
      ? identity.name
      : undefined);
  const details = [KIND_LABELS[account.kind] ?? account.kind, who].filter(
    (detail): detail is string => Boolean(detail)
  );
  return `${account.name} (${details.join(", ")})`;
}

/**
 * "Account on Linear: test-automation-1 (personal, qa@example.com)", one line
 * per server in recorded order, each account once. A fan-out launch shares
 * one launcher, so its runs' accounts are listed together.
 */
export function runAccountLines(
  runs: readonly RunWithAccounts[],
  serverNames: ReadonlyMap<string, string>
): string[] {
  const servers = new Map<string, string[]>();
  for (const account of recordedAccounts(runs)) {
    const texts = servers.get(account.serverId) ?? [];
    const cases = account.cases?.map(({ testCaseId, source }) => `${testCaseId} (${source})`);
    const text = cases?.length ? `${accountText(account)} for ${cases.join(", ")}` : accountText(account);
    if (!texts.includes(text)) texts.push(text);
    servers.set(account.serverId, texts);
  }
  return [...servers].map(([serverId, texts]) =>
    sanitizeTerminalText(
      `${texts.length === 1 ? "Account" : "Accounts"} on ${
        serverNames.get(serverId) ?? serverId
      }: ${texts.join(", ")}`
    )
  );
}

export function writeRunAccounts(
  format: string,
  runs: readonly RunWithAccounts[],
  serverNames: ReadonlyMap<string, string>,
  out: Pick<NodeJS.WriteStream, "write"> = process.stdout
): void {
  if (format !== "human") return;
  for (const line of runAccountLines(runs, serverNames)) out.write(`${line}\n`);
}
