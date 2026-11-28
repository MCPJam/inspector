import { Badge } from "@mcpjam/design-system/badge";
import { useSuiteAccounts } from "@/hooks/use-suite-accounts";
import { useEvalAccountSelectionEnabled } from "@/hooks/useEvalAccountSelectionEnabled";
import type {
  SharedEvalAccountSelection,
  SuiteAccountsServer,
} from "@/lib/evals/eval-accounts";
import { AccountPicker, ServerLabel } from "./account-picker";
import type { EvalCase, EvalSuite } from "./types";

function accountName(server: SuiteAccountsServer, connectionId: string) {
  return (
    server.accounts.find((account) => account.connectionId === connectionId)
      ?.name ?? "Account unavailable"
  );
}

function withSelection(
  selections: readonly SharedEvalAccountSelection[] | undefined,
  serverId: string,
  connectionId: string,
): SharedEvalAccountSelection[] {
  const remaining = (selections ?? []).filter(
    (entry) => entry.serverId !== serverId,
  );
  return connectionId ? [...remaining, { serverId, connectionId }] : remaining;
}

/**
 * What the empty choice falls back to: the suite default when one is set,
 * otherwise the server's default account.
 */
function inheritFor(server: SuiteAccountsServer, suiteAccount?: string) {
  if (suiteAccount) {
    const name = accountName(server, suiteAccount);
    return {
      label: `Suite default · ${name}`,
      accountName: name,
      note: "(suite default)",
    };
  }
  const fallback = server.accounts.find((account) => account.isDefault);
  return fallback
    ? {
        label: `Server default · ${fallback.name}`,
        accountName: fallback.name,
        note: "(server default)",
      }
    : { label: "Server default" };
}

/** "1 case uses its own account (Personal)". */
export function casePinsNote(
  server: SuiteAccountsServer,
  cases: readonly EvalCase[] | undefined,
): string | null {
  const names = (cases ?? []).flatMap((test) => {
    const pin = test.accounts?.find(
      (entry) => entry.serverId === server.serverId,
    );
    return pin ? [accountName(server, pin.connectionId)] : [];
  });
  if (!names.length) return null;
  const unique = [...new Set(names)].join(", ");
  return names.length === 1
    ? `1 case uses its own account (${unique})`
    : `${names.length} cases use their own accounts (${unique})`;
}

/**
 * One account picker per shared server, as a settings field. The server is
 * named only when there are several, since a single one is in the heading.
 */
export function SharedServerAccountRows({
  servers,
  serverName,
  selections,
  onChange,
  disabled,
  suiteDefaults,
  editingSuite,
  cases,
}: {
  servers: SuiteAccountsServer[];
  serverName: (serverId: string) => string;
  selections?: SharedEvalAccountSelection[];
  onChange: (value: SharedEvalAccountSelection[]) => void;
  disabled: boolean;
  suiteDefaults?: SharedEvalAccountSelection[];
  /** Choosing the suite default itself, so there is none to inherit. */
  editingSuite?: boolean;
  cases?: readonly EvalCase[];
}) {
  const several = servers.length > 1;
  return (
    <div className="space-y-3">
      {servers.map((server) => {
        const { serverId } = server;
        const name = serverName(serverId);
        const selected =
          selections?.find((entry) => entry.serverId === serverId)
            ?.connectionId ?? "";
        const suiteAccount = editingSuite
          ? undefined
          : (suiteDefaults?.find((entry) => entry.serverId === serverId)
              ?.connectionId ?? server.suiteConnectionId);
        const note = casePinsNote(server, cases);
        return (
          <div key={serverId} className="space-y-1.5">
            {several ? <ServerLabel name={name} className="text-xs" /> : null}
            <AccountPicker
              variant="field"
              ariaLabel={`${name} account`}
              accounts={server.accounts}
              value={selected}
              disabled={disabled}
              inherit={inheritFor(server, suiteAccount)}
              onChange={(connectionId) =>
                onChange(withSelection(selections, serverId, connectionId))
              }
            />
            {note ? (
              <p className="text-xs text-muted-foreground">{note}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/**
 * "Runs as [W] Work (suite default) ▾ · [server] Mail" under a case's title:
 * the account saved on the case, one picker per shared server.
 */
export function CaseAccountPicker({
  suite,
  projectId,
  selections,
  onChange,
  disabled,
  className,
}: {
  suite: EvalSuite;
  projectId?: string | null;
  selections?: SharedEvalAccountSelection[];
  onChange: (value: SharedEvalAccountSelection[]) => void;
  disabled: boolean;
  className?: string;
}) {
  const { view, serverName } = useSuiteAccounts(
    suite,
    projectId ?? suite.projectId,
  );
  const enabled = useEvalAccountSelectionEnabled();
  if (!enabled && !selections?.length) return null;
  // One account leaves nothing to pin, unless a pin is already saved.
  const servers = view?.servers.filter(
    (server) =>
      server.mode === "shared" &&
      server.managed &&
      (server.accounts.length > 1 ||
        selections?.some((entry) => entry.serverId === server.serverId)),
  );
  if (!servers?.length) return null;
  return (
    <div
      className={className}
      data-testid="case-accounts-shared"
    >
      {servers.map((server) => {
        const { serverId } = server;
        const name = serverName(serverId);
        const pinned =
          selections?.find((entry) => entry.serverId === serverId)
            ?.connectionId ?? "";
        return (
          <div
            key={serverId}
            className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
          >
            <span>Runs as</span>
            <AccountPicker
              ariaLabel={`${name} account`}
              accounts={server.accounts}
              value={pinned}
              disabled={disabled || !enabled}
              inherit={inheritFor(server, server.suiteConnectionId)}
              onChange={(connectionId) =>
                onChange(withSelection(selections, serverId, connectionId))
              }
            />
            {pinned ? (
              <Badge
                variant="outline"
                className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                Pinned
              </Badge>
            ) : null}
            <span aria-hidden>·</span>
            <ServerLabel name={name} />
          </div>
        );
      })}
    </div>
  );
}
