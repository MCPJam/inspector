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
import { useWebClientsEnabled } from "@/hooks/useWebClientsEnabled";
import { useSuiteWebAccounts } from "@/hooks/use-web-accounts";
import { webAccountsApi } from "@/lib/web-accounts/api";
import { webAccountName, webClientName } from "@/lib/web-accounts/clients";
import { WEB_CLIENT_VENDORS, type WebClientVendor } from "@/shared/web-clients";
import { useSuiteAccounts } from "@/hooks/use-suite-accounts";
import { shouldQueryProjectId } from "@/hooks/useProjects";
import {
  checkedAccountIds,
  choosesAccounts,
  SET_SUITE_ACCOUNT_SELECTION_MUTATION,
  type SharedEvalAccountSelection,
  type SuiteAccountsServer,
  type SuiteAccountsView,
} from "@/lib/evals/eval-accounts";
import { SuiteSettingsRow } from "./suite-settings-row";
import type { EvalCase, EvalSuite } from "./types";

const setSuiteAccountSelection = makeFunctionReference<
  "mutation",
  { suiteId: string; serverId: string; connectionIds: string[] },
  unknown
>(SET_SUITE_ACCOUNT_SELECTION_MUTATION);

/** Marks a server whose accounts are the project's, as the Authorization tab says. */
const SHARED_TAG = "Shared with the project";

export const SUITE_ACCOUNTS_HINT =
  "Set a default for each shared MCP server. A case can pin a different account.";

type SharedDefaultsDraft = {
  value: SharedEvalAccountSelection[] | undefined;
  onChange: (value: SharedEvalAccountSelection[]) => void;
  disabled: boolean;
};

/**
 * Shared server defaults participate in the settings draft. Personal server
 * and web-client preferences still save to the person who owns them.
 */
export function SuiteAccountsRow({
  suite,
  projectId,
  sharedDefaults,
}: {
  suite: EvalSuite;
  projectId?: string | null;
  sharedDefaults?: SharedDefaultsDraft;
}) {
  const enabled = useEvalAccountSelectionEnabled();
  // Web accounts follow their own flag alone, with or without server accounts.
  const webClients = useWebClientsEnabled();
  const project = projectId ?? suite.projectId ?? null;
  // Accounts belong to a hosted project. A local one has no servers query to
  // wait on, so the row would read "Loading accounts…" forever.
  if (!project || !shouldQueryProjectId(project)) return null;
  if (enabled)
    return (
      <SuiteAccountsSection
        suite={suite}
        projectId={project}
        webAccounts={webClients}
        sharedDefaults={sharedDefaults}
      />
    );
  if (!webClients) return null;
  return (
    <SuiteWebAccountsGroup
      suiteId={suite._id}
      projectId={project}
      frame={(group) => (
        <SuiteSettingsRow
          settingKey="accounts"
          chained={false}
          data-subsection-id="accounts"
          hint={SUITE_ACCOUNTS_HINT}
        >
          {group}
        </SuiteSettingsRow>
      )}
    />
  );
}

function SuiteAccountsSection({
  suite,
  projectId,
  webAccounts,
  sharedDefaults,
}: {
  suite: EvalSuite;
  projectId: string;
  webAccounts: boolean;
  sharedDefaults?: SharedDefaultsDraft;
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
          Could not load MCP server accounts. Reload the page to try again.
        </p>
      ) : loading ? (
        <p className="text-xs text-muted-foreground">Loading accounts…</p>
      ) : view && serverIds.length ? (
        <SuiteAccountGroups
          suiteId={suite._id}
          view={view}
          serverName={serverName}
          sharedDefaults={sharedDefaults}
        />
      ) : (
        <p className="text-xs text-muted-foreground">
          None of this suite's servers use an account.
        </p>
      )}
      {webAccounts ? (
        <SuiteWebAccountsGroup
          suiteId={suite._id}
          projectId={projectId}
          frame={(group) => <div className="pt-4">{group}</div>}
        />
      ) : null}
    </SuiteSettingsRow>
  );
}

/**
 * Claude web and ChatGPT web, in a group of their own so no client sits
 * under a Server heading: which project web accounts this person's runs sign
 * in as. Hidden while the project has none.
 */
function SuiteWebAccountsGroup({
  suiteId,
  projectId,
  frame,
}: {
  suiteId: string;
  projectId: string;
  frame: (group: ReactNode) => ReactNode;
}) {
  const { accounts, selections, selectionsLoaded } = useSuiteWebAccounts(
    suiteId,
    projectId,
  );
  const save = useMutation(webAccountsApi.setSuiteSelection);
  const [pending, setPending] = useState<Partial<Record<string, string[]>>>({});
  // Each web client reads as a shared server, so the server rows' choices,
  // and their rules, carry over.
  const rows = WEB_CLIENT_VENDORS.map((vendor) => {
    const server: SuiteAccountsServer = {
      serverId: vendor,
      mode: "shared",
      accounts: accounts
        .filter((account) => account.vendor === vendor)
        .map((account) => ({
          connectionId: account.webAccountId,
          name: webAccountName(account),
          isDefault: account.isDefault,
          needsReauth: account.status === "needs_sign_in",
        })),
      chosen:
        selections.find((selection) => selection.vendor === vendor)
          ?.webAccountIds ?? null,
    };
    return { vendor, server };
  }).filter(({ server }) => server.accounts.length);
  if (!rows.length) return null;

  const choose = async (vendor: WebClientVendor, next: string[]) => {
    setPending((current) => ({ ...current, [vendor]: next }));
    try {
      await save({ suiteId, vendor, webAccountIds: next });
    } catch (failure) {
      const fallback = `Couldn't save your ${webClientName(vendor)} accounts. Try again.`;
      const refusal = describeConvexFailure(failure, fallback);
      toast.error(refusal.refusal ? refusal.message : fallback);
    } finally {
      setPending((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([id]) => id !== vendor),
        ),
      );
    }
  };

  return frame(
    <AccountGroup
      testId="suite-accounts-web"
      title="Web clients"
      description="The accounts Claude web and ChatGPT web sign in as for runs you start and schedules you own."
      footer="Teammates choose their own accounts."
      column="Client"
    >
      {rows.map(({ vendor, server }) => (
        <AccountServerRow key={vendor} name={webClientName(vendor)}>
          <AccountChoices
            server={server}
            serverName={webClientName(vendor)}
            checked={pending[vendor] ?? checkedAccountIds(server)}
            // Until the saved choice loads the default shows as checked,
            // and a click would save over the person's real choice.
            saving={vendor in pending || !selectionsLoaded}
            onChange={(next) => void choose(vendor, next)}
            needsReauthLabel="Needs sign-in"
          />
        </AccountServerRow>
      ))}
    </AccountGroup>,
  );
}

/** The three groups, given a loaded view. Exported for the row's tests. */
export function SuiteAccountGroups({
  suiteId,
  view,
  serverName,
  sharedDefaults,
}: {
  suiteId: string;
  view: SuiteAccountsView;
  serverName: (serverId: string) => string;
  sharedDefaults?: SharedDefaultsDraft;
}) {
  const save = useMutation(setSuiteAccountSelection);
  // A save in flight shows its result at once; the query then confirms it,
  // and a failure falls back to what the query says.
  const [pending, setPending] = useState<Record<string, string[]>>({});
  const own = view.servers.filter((server) =>
    sharedDefaults ? server.mode === "accounts" : choosesAccounts(server),
  );
  const shared = sharedDefaults
    ? view.servers.filter((server) => server.mode === "shared")
    : [];
  const project = view.servers.filter((server) => server.mode === "xaa");
  const personalServers = new Set(own.map((server) => server.serverId));
  const scheduleOwners = view.scheduleOwners.flatMap((owner) => {
    const servers = sharedDefaults
      ? owner.servers.filter((server) => personalServers.has(server.serverId))
      : owner.servers;
    return servers.length ? [{ ...owner, servers }] : [];
  });
  if (!own.length && !shared.length && !project.length && !scheduleOwners.length) {
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
      {shared.length && sharedDefaults ? (
        <AccountGroup testId="suite-accounts-shared" title="Shared MCP servers">
          <SharedServerAccountRows
            servers={shared}
            serverName={serverName}
            selections={sharedDefaults.value}
            onChange={sharedDefaults.onChange}
            disabled={sharedDefaults.disabled}
            inheritLabel="Use project server default"
          />
        </AccountGroup>
      ) : null}
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
              tag={server.mode === "shared" ? SHARED_TAG : undefined}
            >
              <AccountChoices
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
              <span>
                {server.xaaSubject ? `${server.xaaSubject} ` : null}
                <span className="text-muted-foreground">
                  Simulated identity
                </span>
              </span>
            </AccountServerRow>
          ))}
        </AccountGroup>
      ) : null}
      {scheduleOwners.map((owner, index) => (
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

export function CaseServerAccounts({
  suite,
  projectId,
  selections,
  onChange,
  disabled,
}: {
  suite: EvalSuite;
  projectId?: string | null;
  selections?: SharedEvalAccountSelection[];
  onChange: (value: SharedEvalAccountSelection[]) => void;
  disabled: boolean;
}) {
  const { view, serverName } = useSuiteAccounts(suite, projectId ?? suite.projectId);
  const servers = view?.servers.filter((server) => server.mode === "shared");
  if (!servers?.length) return null;
  return (
    <details className="mx-4 my-2 shrink-0 text-xs sm:mx-6">
      <summary className="cursor-pointer">MCP server accounts</summary>
      <div className="mt-2">
        <AccountGroup testId="case-accounts-shared" title="Case account overrides">
          <SharedServerAccountRows
            servers={servers}
            serverName={serverName}
            selections={selections}
            onChange={onChange}
            disabled={disabled}
            inheritLabel="Inherit run account"
          />
        </AccountGroup>
      </div>
    </details>
  );
}

export function SharedServerAccountRows({
  servers,
  serverName,
  selections,
  onChange,
  disabled,
  inheritLabel,
  suiteDefaults,
  cases,
}: {
  servers: SuiteAccountsServer[];
  serverName: (serverId: string) => string;
  selections?: SharedEvalAccountSelection[];
  onChange: (value: SharedEvalAccountSelection[]) => void;
  disabled: boolean;
  inheritLabel: string;
  suiteDefaults?: SharedEvalAccountSelection[];
  cases?: readonly EvalCase[];
}) {
  return servers.map((server) => {
    const { serverId, accounts } = server;
    const name = serverName(serverId);
    const selected = selections?.find((entry) => entry.serverId === serverId)?.connectionId ?? "";
    const labelFor = (connectionId: string) =>
      accounts.find((account) => account.connectionId === connectionId)?.name ?? "Account unavailable";
    const suiteAccount = suiteDefaults?.find((entry) => entry.serverId === serverId)?.connectionId;
    const casePins = cases?.flatMap((test) => {
      const pin = test.accounts?.find((entry) => entry.serverId === serverId);
      return pin ? [{ caseId: test._id, title: test.title, name: labelFor(pin.connectionId) }] : [];
    });
    return (
      <AccountServerRow key={serverId} name={name}>
        <select
          aria-label={`${name} account`}
          className="max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
          disabled={disabled}
          value={selected}
          onChange={(event) => {
            const remaining = (selections ?? []).filter((entry) => entry.serverId !== serverId);
            const connectionId = event.target.value;
            onChange(connectionId ? [...remaining, { serverId, connectionId }] : remaining);
          }}
        >
          <option value="">{suiteAccount ? `Suite default · ${labelFor(suiteAccount)}` : inheritLabel}</option>
          {selected && !accounts.some((account) => account.connectionId === selected) ? (
            <option value={selected} disabled>Account unavailable</option>
          ) : null}
          {accounts.map((account) => (
            <option key={account.connectionId} value={account.connectionId} disabled={account.needsReauth}>
              {account.needsReauth ? `${account.name} (needs reconnect)` : account.name}
            </option>
          ))}
        </select>
        {casePins?.length ? (
          <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
            {casePins.map((pin) => (
              <li key={pin.caseId}>{pin.title || "Untitled case"} · {pin.name} · case override</li>
            ))}
          </ul>
        ) : null}
      </AccountServerRow>
    );
  });
}

function AccountChoices({
  server,
  serverName,
  checked,
  saving,
  onChange,
  needsReauthLabel,
}: {
  server: SuiteAccountsServer;
  serverName: string;
  checked: readonly string[];
  saving: boolean;
  onChange: (next: string[]) => void;
  /** A web account needs sign-in rather than a reconnect. */
  needsReauthLabel?: string;
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
    // Only a project admin connects a project account, on the server's page.
    const shared = server.mode === "shared";
    return (
      <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
        {shared
          ? "No project account yet. A project admin can connect one on the server's page."
          : "No account connected."}
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => navigateApp(buildProjectServerPath(server.serverId))}
        >
          {shared ? "Open server" : "Connect one"}
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
            {account.needsReauth ? (
              <NeedsReconnectTag label={needsReauthLabel} />
            ) : null}
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
export function NeedsReconnectTag({
  label = "Needs reconnect",
}: {
  label?: string;
}) {
  return (
    <span className="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive">
      {label}
    </span>
  );
}

export function AccountGroup({
  testId,
  title,
  tag,
  description,
  footer,
  column = "Server",
  children,
}: {
  testId: string;
  title: string;
  tag?: string;
  description?: string;
  footer?: string;
  /** What each row names. */
  column?: string;
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
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b border-border/60">
            <th scope="col" className="w-[35%] px-4 py-2 font-medium">
              {column}
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
  tag,
  children,
}: {
  name: string;
  tag?: string;
  children: ReactNode;
}) {
  return (
    <tr className="border-b border-border/60 last:border-0">
      <th
        scope="row"
        className="break-words px-4 py-2.5 align-top font-medium text-foreground"
      >
        {tag ? (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* The space keeps the name and the tag apart when read aloud. */}
            {name}{" "}
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[10px] font-normal text-muted-foreground"
            >
              {tag}
            </Badge>
          </span>
        ) : (
          name
        )}
      </th>
      <td className="px-4 py-2.5 align-top text-foreground">{children}</td>
    </tr>
  );
}
