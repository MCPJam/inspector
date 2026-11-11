import { Fragment } from "react";
import { UserRound } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEvalAccountSelectionEnabled } from "@/hooks/useEvalAccountSelectionEnabled";
import { useSuiteAccounts } from "@/hooks/use-suite-accounts";
import { runsAsEntries, type RunsAsEntry } from "@/lib/evals/eval-accounts";
import { NeedsReconnectTag } from "../evals/suite-accounts-row";
import type { EvalSuite } from "../evals/types";

/**
 * "Runs as you · Asana Dummy": the person's own accounts a run of this suite
 * will use, one server after another. Nothing when no server signs in with
 * the person's own account.
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
        "flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground",
        className,
      )}
      data-testid="suite-runs-as"
    >
      <UserRound className="size-3.5 shrink-0" aria-hidden />
      <span>Runs as you</span>
      {entries.map((entry) => (
        <Fragment key={entry.serverId}>
          <span aria-hidden> · </span>
          <span className="inline-flex flex-wrap items-center gap-1">
            <span>{entry.serverName} </span>
            <span className="text-foreground">
              {entry.accounts.map((account) => account.name).join(", ")}
            </span>
            {entry.accounts.some((account) => account.needsReauth) ? (
              <>
                {" "}
                <NeedsReconnectTag />
              </>
            ) : null}
          </span>
        </Fragment>
      ))}
    </p>
  );
}

/** {@link RunsAsLine} for a suite, read while the rollout flag is on. */
export function SuiteRunsAsLine({
  suite,
  projectId,
  className,
}: {
  suite: EvalSuite;
  projectId?: string | null;
  className?: string;
}) {
  const enabled = useEvalAccountSelectionEnabled();
  if (!enabled) return null;
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
