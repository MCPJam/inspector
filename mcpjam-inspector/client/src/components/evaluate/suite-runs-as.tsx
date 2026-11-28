import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { useSuiteAccounts } from "@/hooks/use-suite-accounts";
import { runsAsEntries, type RunsAsEntry } from "@/lib/evals/eval-accounts";
import { AccountAvatar } from "../evals/account-avatar";
import { ServerLabel } from "../evals/account-picker";
import { NeedsReconnectTag } from "../evals/suite-accounts-row";
import type { EvalSuite } from "../evals/types";

/** An account's avatar and name, as the account pickers show it. */
export function AccountName({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
      <AccountAvatar name={name} />
      <span className="truncate font-medium">{name}</span>
    </span>
  );
}

/**
 * "Runs as [W] Work · [server] Mail": the accounts a run of this suite will
 * use, then the server they are on, one server after another. Nothing when no
 * server has such a choice.
 */
export function RunsAsLine({
  entries,
  className,
}: {
  entries: readonly RunsAsEntry[] | undefined;
  className?: string;
}) {
  if (!entries?.length) return null;
  return (
    <p
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
      data-testid="suite-runs-as"
    >
      <span>Runs as</span>
      {entries.map((entry, index) => (
        <Fragment key={entry.serverId}>
          {index > 0 ? <span aria-hidden>·</span> : null}
          <span className="inline-flex min-w-0 flex-wrap items-center gap-2">
            {entry.accounts.map((account) => (
              <AccountName key={account.name} name={account.name} />
            ))}
            {entry.accounts.some((account) => account.needsReauth) ? (
              <NeedsReconnectTag />
            ) : null}
            {entries.length > 1 ? null : <span aria-hidden>·</span>}
            <ServerLabel name={entry.serverName} />
          </span>
        </Fragment>
      ))}
    </p>
  );
}

/** {@link RunsAsLine} for a suite. */
export function SuiteRunsAsLine({
  suite,
  projectId,
  className,
}: {
  suite: EvalSuite;
  projectId?: string | null;
  className?: string;
}) {
  return (
    <LoadedRunsAsLine
      suite={suite}
      projectId={projectId ?? suite.projectId ?? null}
      className={className}
    />
  );
}

function LoadedRunsAsLine({
  suite,
  projectId,
  className,
}: {
  suite: EvalSuite;
  projectId: string | null;
  className?: string;
}) {
  const { view, serverName } = useSuiteAccounts(suite, projectId);
  return (
    <RunsAsLine
      entries={view ? runsAsEntries(view, serverName) : undefined}
      className={className}
    />
  );
}
