import { useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { toast } from "sonner";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { cn } from "@/lib/utils";
import { describeConvexFailure } from "@/lib/convex-error";
import { buildProjectServerPath, navigateApp } from "@/lib/app-navigation";
import { useEvalAccountSelectionEnabled } from "@/hooks/useEvalAccountSelectionEnabled";
import { useSuiteAccounts } from "@/hooks/use-suite-accounts";
import {
  checkedAccountIds,
  SET_SUITE_ACCOUNT_SELECTION_MUTATION,
  type SuiteAccountsServer,
  type SuiteAccountsView,
} from "@/lib/evals/eval-accounts";
import { SuiteSettingsRow } from "./suite-settings-row";
import type { EvalSuite } from "./types";

const setSuiteAccountSelection = makeFunctionReference<
  "mutation",
  { suiteId: string; serverId: string; connectionIds: string[] },
  unknown
>(SET_SUITE_ACCOUNT_SELECTION_MUTATION);

export const SUITE_ACCOUNTS_HINT =
  "Each run uses the accounts of the person who starts it. A schedule uses its owner's accounts, and an API or CLI run uses the key owner's.";

/**
 * Suite settings → Accounts: which of the person's own accounts this suite
 * runs with, per server, beside the project's fixed connections and the
 * accounts each schedule owner's runs use.
 *
 * The choice belongs to the person, not the suite, so it is not part of the
 * settings draft: each checkbox saves right away, like "Where it runs".
 */
export function SuiteAccountsRow({
  suite,
  projectId,
}: {
  suite: EvalSuite;
  projectId?: string | null;
}) {
  const enabled = useEvalAccountSelectionEnabled();
  if (!enabled) return null;
  return (
    <SuiteAccountsSection
      suite={suite}
      projectId={projectId ?? suite.projectId ?? null}
    />
  );
}

function SuiteAccountsSection({
  suite,
  projectId,
}: {
  suite: EvalSuite;
  projectId: string | null;
}) {
  const { view, error, loading, serverIds, serverName } = useSuiteAccounts(
    suite,
    projectId,
  );
  return (
    <SuiteSettingsRow
      settingKey="accounts"
      chained={false}
      data-subsection-id="accounts"
      hint={SUITE_ACCOUNTS_HINT}
    >
      {error ? (
        <p className="text-xs text-destructive">
          Could not load your accounts. Reload the page to try again.
        </p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">Loading accounts…</p>
      ) : view && serverIds.length ? (
        <SuiteAccountGroups
          suiteId={suite._id}
          view={view}
          serverName={serverName}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          None of this suite's servers use an account.
        </p>
      )}
    </SuiteSettingsRow>
  );
}

/** The three groups, given a loaded view. Exported for the row's tests. */
export function SuiteAccountGroups({
  suiteId,
  view,
  serverName,
}: {
  suiteId: string;
  view: SuiteAccountsView;
  serverName: (serverId: string) => string;
}) {
  const save = useMutation(setSuiteAccountSelection);
  // A save in flight shows its result at once; the query then confirms it,
  // and a failure falls back to what the query says.
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const own = view.servers.filter((server) => server.mode === "accounts");
  const project = view.servers.filter(
    (server) => server.mode === "shared" || server.mode === "xaa",
  );
  if (!own.length && !project.length && !view.scheduleOwners.length) {
    return (
      <p className="text-xs text-muted-foreground">
        None of this suite's servers use an account.
      </p>
    );
  }

  const choose = async (server: SuiteAccountsServer, next: string[]) => {
    const { serverId } = server;
    setPending((current) => ({ ...current, [serverId]: next }));
    try {
      await save({ suiteId, serverId, connectionIds: next });
    } catch (failure) {
      console.warn("[Suite settings] Could not save accounts.", failure);
      // The backend's own sentence when it refused the choice; otherwise ours.
      const fallback = `Could not save your ${serverName(serverId)} accounts. Try again.`;
      const refusal = describeConvexFailure(failure, fallback);
      toast.error(refusal.refusal ? refusal.message : fallback);
    } finally {
      setPending((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => id !== serverId),
        ),
      );
    }
  };

  return (
    <div className="space-y-4">
      {own.length ? (
        <AccountGroup
          testId="suite-accounts-mine"
          title="Runs as you"
          description="Used by runs you start in the app or with your API key, and by schedules you own."
          footer="Teammates choose their own accounts."
        >
          {own.map((server) => (
            <AccountServerRow
              key={server.serverId}
              name={serverName(server.serverId)}
            >
              <OwnAccounts
                server={server}
                serverName={serverName(server.serverId)}
                checked={pending[server.serverId] ?? checkedAccountIds(server)}
                saving={server.serverId in pending}
                onChange={(next) => void choose(server, next)}
              />
            </AccountServerRow>
          ))}
        </AccountGroup>
      ) : null}
      {project.length ? (
        <AccountGroup
          testId="suite-accounts-project"
          title="Project connections"
          description="Every run uses these, whoever starts it."
        >
          {project.map((server) => (
            <AccountServerRow
              key={server.serverId}
              name={serverName(server.serverId)}
            >
              {server.mode === "shared" ? (
                <span>Shared with the project</span>
              ) : (
                <span>
                  {server.xaaSubject ? `${server.xaaSubject} ` : null}
                  <span className="text-muted-foreground">
                    Simulated identity
                  </span>
                </span>
              )}
            </AccountServerRow>
          ))}
        </AccountGroup>
      ) : null}
      {view.scheduleOwners.map((owner, index) => (
        <AccountGroup
          key={`${owner.name}:${index}`}
          testId="suite-accounts-schedule-owner"
          title={`Runs as ${owner.name}`}
          tag="Schedule owner"
          description={`Used by the schedule ${owner.name} owns. Only ${owner.name} can change these accounts.`}
        >
          {owner.servers.map((server) => (
            <AccountServerRow
              key={server.serverId}
              name={serverName(server.serverId)}
            >
              {server.accountNames.join(", ") || (
                <span className="text-muted-foreground">None</span>
              )}
            </AccountServerRow>
          ))}
        </AccountGroup>
      ))}
    </div>
  );
}

function OwnAccounts({
  server,
  serverName,
  checked,
  saving,
  onChange,
}: {
  server: SuiteAccountsServer;
  serverName: string;
  checked: readonly string[];
  saving: boolean;
  onChange: (next: string[]) => void;
}) {
  const listed = new Set(server.accounts.map((a) => a.connectionId));
  const removed = Boolean(server.chosen?.some((id) => !listed.has(id)));
  // What saving again would keep: the accounts still ticked, or the only
  // account left when every chosen one is gone. Several accounts and none
  // ticked: ticking one saves.
  const keep = checked.length
    ? [...checked]
    : server.accounts.length === 1
      ? [server.accounts[0].connectionId]
      : [];
  if (!server.accounts.length) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
        No account connected.
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => navigateApp(buildProjectServerPath(server.serverId))}
        >
          Connect one
        </Button>
      </span>
    );
  }
  return (
    <div className="space-y-1.5" aria-busy={saving}>
      {server.accounts.map((account) => {
        const isChecked = checked.includes(account.connectionId);
        // At least one account stays chosen: an empty choice would mean
        // "my default", which is a different thing to ask for.
        const lastOne = isChecked && checked.length === 1;
        const marks = (
          <>
            {account.isDefault ? (
              <Badge
                variant="outline"
                className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
              >
                Default
              </Badge>
            ) : null}
            {account.needsReauth ? <NeedsReconnectTag /> : null}
          </>
        );
        if (server.accounts.length === 1) {
          return (
            <span
              key={account.connectionId}
              className="flex flex-wrap items-center gap-2"
            >
              {account.name}
              {marks}
            </span>
          );
        }
        return (
          <label
            key={account.connectionId}
            className={cn(
              "flex w-fit flex-wrap items-center gap-2",
              lastOne || saving ? "cursor-default" : "cursor-pointer",
            )}
            title={lastOne ? "Keep at least one account." : undefined}
          >
            <Checkbox
              checked={isChecked}
              disabled={saving || lastOne}
              aria-label={`${serverName} ${account.name}`}
              onCheckedChange={(value) =>
                onChange(
                  value === true
                    ? server.accounts
                        .map((a) => a.connectionId)
                        .filter(
                          (id) =>
                            id === account.connectionId || checked.includes(id),
                        )
                    : checked.filter((id) => id !== account.connectionId),
                )
              }
            />
            {account.name}
            {marks}
          </label>
        );
      })}
      {removed ? (
        <p className="text-xs text-destructive">
          An account chosen for {serverName} was removed. Choose again.{" "}
          {keep.length ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              disabled={saving}
              onClick={() => onChange(keep)}
            >
              Save this choice
            </Button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

/** "Needs reconnect", the words the Authorization tab uses. */
export function NeedsReconnectTag() {
  return (
    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
      Needs reconnect
    </span>
  );
}

function AccountGroup({
  testId,
  title,
  tag,
  description,
  footer,
  children,
}: {
  testId: string;
  title: string;
  tag?: string;
  description: string;
  footer?: string;
  children: ReactNode;
}) {
  return (
    <section
      className="overflow-hidden rounded-lg border border-border"
      data-testid={testId}
      aria-label={tag ? `${title} · ${tag}` : title}
    >
      <div className="space-y-0.5 border-b border-border px-4 py-3">
        <h4 className="flex flex-wrap items-center gap-2 text-sm font-medium text-foreground">
          {title}
          {tag ? (
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
            >
              {tag}
            </Badge>
          ) : null}
        </h4>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border/60">
            <th scope="col" className="w-[35%] px-4 py-2 font-medium">
              Server
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Accounts
            </th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {footer ? (
        <p className="border-t border-border/60 px-4 py-2 text-xs text-muted-foreground">
          {footer}
        </p>
      ) : null}
    </section>
  );
}

function AccountServerRow({
  name,
  children,
}: {
  name: string;
  children: ReactNode;
}) {
  return (
    <tr className="border-b border-border/60 last:border-0">
      <th
        scope="row"
        className="break-words px-4 py-2.5 align-top font-medium text-foreground"
      >
        {name}
      </th>
      <td className="px-4 py-2.5 align-top text-foreground">{children}</td>
    </tr>
  );
}
