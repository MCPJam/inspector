import { useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  ScrollText,
  Trash2,
  Users,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Switch } from "@mcpjam/design-system/switch";
import { cn } from "@/lib/utils";
import { LockedIconButton } from "@/components/xaa/registration/XAAResourceAppsSection";
import {
  RegistrationDeleteDialog,
  useRegistrationCrud,
} from "@/components/xaa/registration/registration-crud";
import { XAARegistrationWizard } from "@/components/xaa/registration/XAARegistrationWizard";
import { useOrgXaaPeople } from "@/hooks/useOrgXaaPeople";
import { useOrganizationAudit } from "@/hooks/useOrganizationAudit";
import { useXaaAssignments } from "@/hooks/useXaaAssignments";
import { useXaaManagedConnections } from "@/hooks/useXaaManagedConnections";
import { useXaaResourceApps } from "@/hooks/useXaaResourceApps";
import { openXaaAppInDebugger } from "@/lib/app-navigation";
import {
  effectiveXaaScopes,
  type RemoteOrgXaaPerson,
  type XaaManagedAssignment,
  type XaaManagedConnection,
  type XaaResourceApp,
  type XaaScopeMode,
} from "@/lib/xaa/types";

const LOCKED_REASON = "Only organization admins can manage servers.";
const POLICY_AUDIT_PREFIX = "organization.xaa_policy.";

/** Small pressed/unpressed scope chip. Read-only when onToggle is absent. */
function ScopeChip({
  scope,
  active,
  onToggle,
}: {
  scope: string;
  active: boolean;
  onToggle?: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      disabled={!onToggle}
      onClick={onToggle}
      className={cn(
        "rounded-full border px-2 py-0.5 font-mono text-[10.5px] transition-colors",
        active
          ? "border-primary/60 bg-primary/5 text-foreground"
          : "border-border/60 text-muted-foreground",
        onToggle ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
      )}
    >
      {scope}
    </button>
  );
}

/** All/Selected mode picker rendered as two tiny toggle buttons. */
function ScopeModePicker({
  mode,
  onChange,
  disabled,
}: {
  mode: XaaScopeMode;
  onChange?: (mode: XaaScopeMode) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex items-center gap-1">
      {(["all", "selected"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={mode === option}
          disabled={disabled || !onChange}
          onClick={onChange ? () => onChange(option) : undefined}
          className={cn(
            "rounded-md border px-2 py-0.5 text-[10.5px] font-medium transition-colors",
            mode === option
              ? "border-primary/60 bg-primary/5 text-foreground"
              : "border-border/60 text-muted-foreground",
            onChange && !disabled
              ? "cursor-pointer hover:bg-muted/40"
              : "cursor-default opacity-80",
          )}
        >
          {option === "all" ? "All scopes" : "Selected"}
        </button>
      ))}
    </div>
  );
}

function toggleScope(scopes: string[], scope: string): string[] {
  return scopes.includes(scope)
    ? scopes.filter((s) => s !== scope)
    : [...scopes, scope];
}

interface AuditPolicyMetadata {
  code?: string;
  reasonCode?: string;
  policyMode?: string;
}

function extractPolicyMetadata(metadata: unknown): AuditPolicyMetadata {
  if (!metadata || typeof metadata !== "object") return {};
  const m = metadata as Record<string, unknown>;
  return {
    code: typeof m.code === "string" ? m.code : undefined,
    reasonCode: typeof m.reasonCode === "string" ? m.reasonCode : undefined,
    policyMode: typeof m.policyMode === "string" ? m.policyMode : undefined,
  };
}

/**
 * One consolidated server row: name + resource URL, a single Enabled switch
 * (the Agent's connection), an assigned-people summary whose popover assigns
 * and unassigns with a checkbox per person, and a kebab menu for
 * registration actions. Scope configuration and auth-server plumbing live
 * behind the collapsed "Advanced access" disclosure — the default view never
 * asks about scopes.
 */
function AppRow({
  app,
  connection,
  people,
  peopleLoading,
  canManage,
  onUpsertConnection,
  onUpsertAssignment,
  onRemoveAssignment,
  onEdit,
  onDelete,
}: {
  app: XaaResourceApp;
  connection: XaaManagedConnection | undefined;
  people: RemoteOrgXaaPerson[];
  /** Roster still resolving — don't claim "no people" yet. */
  peopleLoading: boolean;
  canManage: boolean;
  onUpsertConnection: (input: {
    resourceAppId: string;
    enabled: boolean;
    scopeMode: XaaScopeMode;
    selectedScopes?: string[];
  }) => Promise<unknown>;
  onUpsertAssignment: (input: {
    connectionId: string;
    testIdentityId: string;
    scopeMode: XaaScopeMode;
    selectedScopes?: string[];
  }) => Promise<unknown>;
  onRemoveAssignment: (assignmentId: string) => Promise<unknown>;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const appScopes = app.scopes ?? [];
  const connectionScopes = connection
    ? effectiveXaaScopes(
        connection.scopeMode,
        connection.selectedScopes,
        appScopes,
      )
    : [];

  const assignments = connection?.assignments ?? [];

  const peopleById = useMemo(() => {
    const map = new Map<string, RemoteOrgXaaPerson>();
    for (const person of people) map.set(person._id, person);
    return map;
  }, [people]);

  const assignmentByPersonId = useMemo(() => {
    const map = new Map<string, XaaManagedAssignment>();
    for (const assignment of assignments)
      map.set(assignment.testIdentityId, assignment);
    return map;
  }, [assignments]);

  // The popover offers a checkbox per active person; suspended people appear
  // only while they still hold an assignment (so they can be unassigned).
  const assignablePeople = useMemo(
    () =>
      people.filter(
        (p) => p.status === "active" || assignmentByPersonId.has(p._id),
      ),
    [people, assignmentByPersonId],
  );

  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } catch {
      // Errors surface through the owning hooks' `error` state.
    } finally {
      setBusy(false);
    }
  };

  // On = grant consent (create the connection with the "everything the app
  // declares" default); a mere re-toggle preserves the stored scope config.
  const setEnabled = (enabled: boolean) =>
    run(() =>
      onUpsertConnection({
        resourceAppId: app.id,
        enabled,
        scopeMode: connection?.scopeMode ?? "all",
        ...(connection?.scopeMode === "selected"
          ? { selectedScopes: connection.selectedScopes ?? [] }
          : {}),
      }),
    );

  const setScopeMode = (mode: XaaScopeMode) => {
    if (!connection) return;
    void run(() =>
      onUpsertConnection({
        resourceAppId: app.id,
        enabled: connection.enabled,
        scopeMode: mode,
        // Flipping to "selected" starts from the current effective set so the
        // change is a no-op until the admin narrows it.
        ...(mode === "selected"
          ? { selectedScopes: connection.selectedScopes ?? appScopes }
          : {}),
      }),
    );
  };

  const toggleConnectionScope = (scope: string) => {
    if (!connection) return;
    void run(() =>
      onUpsertConnection({
        resourceAppId: app.id,
        enabled: connection.enabled,
        scopeMode: "selected",
        selectedScopes: toggleScope(connection.selectedScopes ?? [], scope),
      }),
    );
  };

  const setAssignmentMode = (
    assignment: XaaManagedAssignment,
    mode: XaaScopeMode,
  ) => {
    if (!connection) return;
    void run(() =>
      onUpsertAssignment({
        connectionId: connection._id,
        testIdentityId: assignment.testIdentityId,
        scopeMode: mode,
        ...(mode === "selected"
          ? { selectedScopes: assignment.selectedScopes ?? connectionScopes }
          : {}),
      }),
    );
  };

  const toggleAssignmentScope = (
    assignment: XaaManagedAssignment,
    scope: string,
  ) => {
    if (!connection) return;
    void run(() =>
      onUpsertAssignment({
        connectionId: connection._id,
        testIdentityId: assignment.testIdentityId,
        scopeMode: "selected",
        selectedScopes: toggleScope(assignment.selectedScopes ?? [], scope),
      }),
    );
  };

  const setAssigned = (person: RemoteOrgXaaPerson, checked: boolean) => {
    if (!connection) return;
    const assignment = assignmentByPersonId.get(person._id);
    if (checked) {
      if (assignment) return;
      void run(() =>
        onUpsertAssignment({
          connectionId: connection._id,
          testIdentityId: person._id,
          scopeMode: "all",
        }),
      );
    } else if (assignment) {
      void run(() => onRemoveAssignment(assignment._id));
    }
  };

  const peopleSummary = (
    <>
      <Users className="h-3 w-3" />
      {assignments.length}
    </>
  );

  return (
    <div
      data-testid={`xaa-setup-app-${app.id}`}
      className="rounded-md border border-border"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">{app.name}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {app.resourceUrl}
          </div>
        </div>

        {canManage ? (
          <Popover open={peopleOpen} onOpenChange={setPeopleOpen}>
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Assigned people for ${app.name}`}
                className="h-6 gap-1 px-2 text-xs text-muted-foreground"
              >
                {peopleSummary}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-2">
              {!connection ? (
                <p className="px-1 py-0.5 text-xs text-muted-foreground">
                  Turn the server on first — people are assigned to its
                  connection.
                </p>
              ) : peopleLoading ? (
                <p className="flex items-center gap-2 px-1 py-0.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Loading people…
                </p>
              ) : assignablePeople.length === 0 ? (
                <p className="px-1 py-0.5 text-xs text-muted-foreground">
                  No people yet — add them in the People section.
                </p>
              ) : (
                <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                  {assignablePeople.map((person) => (
                    <li key={person._id}>
                      <label className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-muted/40">
                        <Checkbox
                          checked={assignmentByPersonId.has(person._id)}
                          disabled={busy}
                          aria-label={`Assign ${person.name}`}
                          onCheckedChange={(checked) =>
                            setAssigned(person, checked === true)
                          }
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {person.name}
                        </span>
                        {person.status === "suspended" && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400"
                          >
                            Suspended
                          </Badge>
                        )}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
        ) : (
          <LockedIconButton
            label={`Assigned people for ${app.name}`}
            reason={LOCKED_REASON}
          >
            {peopleSummary}
          </LockedIconButton>
        )}

        <Switch
          checked={connection?.enabled === true}
          disabled={!canManage || busy}
          onCheckedChange={(checked) => void setEnabled(checked)}
          aria-label={`Connection for ${app.name}`}
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Actions for ${app.name}`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => openXaaAppInDebugger(app.id)}>
              <Play className="h-3.5 w-3.5" />
              Test in debugger
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!canManage} onSelect={onEdit}>
              <Pencil className="h-3.5 w-3.5" />
              Edit server
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!canManage}
              onSelect={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            aria-label={`Advanced access for ${app.name}`}
            className="flex w-full items-center gap-1.5 border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {advancedOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Advanced access
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-3 border-t border-border/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground"
                title="Where this server's access tokens come from."
              >
                Token source
              </span>
              <Badge variant="secondary" className="text-[10px]">
                {app.resourceType === "mcp" ? "MCP" : "REST"}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {app.authServerMode === "mcpjam" ? "MCPJam AS" : "Own AS"}
              </Badge>
              {app.hasSecret && (
                <KeyRound
                  aria-label="Client secret stored"
                  className="h-3 w-3 text-muted-foreground"
                />
              )}
            </div>

            {!connection ? (
              <p className="text-xs text-muted-foreground">
                This server is off. Turn it on to let assigned people access
                it; runs stay denied until then.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Connection scopes
                  </span>
                  <ScopeModePicker
                    mode={connection.scopeMode}
                    onChange={canManage ? setScopeMode : undefined}
                    disabled={busy}
                  />
                </div>
                {connection.scopeMode === "selected" ? (
                  appScopes.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground">
                      This server declares no scopes — nothing to select.
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {appScopes.map((scope) => (
                        <ScopeChip
                          key={scope}
                          scope={scope}
                          active={(connection.selectedScopes ?? []).includes(
                            scope,
                          )}
                          onToggle={
                            canManage && !busy
                              ? () => toggleConnectionScope(scope)
                              : undefined
                          }
                        />
                      ))}
                      {(connection.selectedScopes ?? []).length === 0 && (
                        <span className="text-[11px] text-amber-600 dark:text-amber-400">
                          No scopes selected — every request is denied.
                        </span>
                      )}
                    </div>
                  )
                ) : null}

                <span className="block text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Assigned people
                </span>
                {assignments.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    No one is assigned — every managed run against this
                    server is denied.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {assignments.map((assignment) => {
                      const person = peopleById.get(assignment.testIdentityId);
                      return (
                        <li
                          key={assignment._id}
                          data-testid={`xaa-access-assignment-${assignment._id}`}
                          className={cn(
                            "rounded-md border border-border/60 px-2.5 py-1.5",
                            person?.status === "suspended" && "opacity-70",
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <span className="min-w-0 flex-1 truncate text-xs font-medium">
                              {person?.name ?? "Unknown person"}
                            </span>
                            {person?.status === "suspended" && (
                              <Badge
                                variant="outline"
                                className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400"
                              >
                                Suspended
                              </Badge>
                            )}
                            <ScopeModePicker
                              mode={assignment.scopeMode}
                              onChange={
                                canManage
                                  ? (mode) =>
                                      setAssignmentMode(assignment, mode)
                                  : undefined
                              }
                              disabled={busy}
                            />
                          </div>
                          {assignment.scopeMode === "selected" && (
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {connectionScopes.map((scope) => (
                                <ScopeChip
                                  key={scope}
                                  scope={scope}
                                  active={(
                                    assignment.selectedScopes ?? []
                                  ).includes(scope)}
                                  onToggle={
                                    canManage && !busy
                                      ? () =>
                                          toggleAssignmentScope(
                                            assignment,
                                            scope,
                                          )
                                      : undefined
                                  }
                                />
                              ))}
                              {connectionScopes.length === 0 && (
                                <span className="text-[11px] text-muted-foreground">
                                  The connection grants no scopes to subset.
                                </span>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * One flat list of servers — the people × servers access matrix. Each row
 * carries the registration, the Agent's connection (a single Enabled
 * switch), and the assigned People (checkbox popover). Scope narrowing,
 * per-assignment subsets, and auth-server plumbing live behind each row's
 * collapsed "Advanced access" disclosure. Registration CRUD shares the
 * debugger's wizard and create/edit/delete flow (registration-crud.tsx,
 * also used by XAAResourceAppsSection); wire names stay protocol-shaped
 * (xaaResourceApps, xaaManagedConnections). A collapsible footer shows
 * recent policy decisions from the org audit log.
 */
export function XAASetupAppsSection({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const {
    resourceApps,
    isLoading: appsLoading,
    error: appsError,
    remove,
  } = useXaaResourceApps(organizationId);
  const {
    connectionByAppId,
    isLoading: connectionsLoading,
    error: connectionsError,
    upsertConnection,
  } = useXaaManagedConnections(organizationId);
  const { people, isLoading: peopleLoading } = useOrgXaaPeople(organizationId);
  const {
    error: assignmentsError,
    upsertAssignment,
    removeAssignment,
  } = useXaaAssignments();
  const crud = useRegistrationCrud(remove);

  const [auditOpen, setAuditOpen] = useState(false);
  const {
    events,
    isLoading: auditLoading,
    error: auditError,
    refresh: refreshAudit,
  } = useOrganizationAudit({
    organizationId,
    isAuthenticated: isConvexAuthenticated,
    initialLimit: 50,
  });

  const policyEvents = useMemo(
    () => events.filter((event) => event.action.startsWith(POLICY_AUDIT_PREFIX)),
    [events],
  );

  const isLoading = appsLoading || connectionsLoading;
  const error = appsError ?? connectionsError ?? assignmentsError;

  return (
    <Card className="gap-0 p-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Servers</h3>
          <p className="truncate text-xs text-muted-foreground">
            Control which people can access each server through the MCPJam
            test IdP.
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={crud.openCreate}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add server
          </Button>
        ) : (
          <LockedIconButton label="Add server" reason={LOCKED_REASON}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add server
          </LockedIconButton>
        )}
      </div>

      <div className="space-y-1.5 px-4 pb-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading servers…
          </div>
        ) : resourceApps.length === 0 ? (
          <div
            data-testid="xaa-setup-apps-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
          >
            No servers yet. Add one, then turn it on and assign people to
            grant access.
          </div>
        ) : (
          resourceApps.map((app) => (
            <AppRow
              key={app.id}
              app={app}
              connection={connectionByAppId.get(app.id)}
              people={people}
              peopleLoading={peopleLoading}
              canManage={canManage}
              onUpsertConnection={upsertConnection}
              onUpsertAssignment={upsertAssignment}
              onRemoveAssignment={removeAssignment}
              onEdit={() => crud.openEdit(app)}
              onDelete={() => crud.setPendingDelete(app)}
            />
          ))
        )}
      </div>

      <Collapsible
        open={auditOpen}
        onOpenChange={(open) => {
          setAuditOpen(open);
          if (open) void refreshAudit();
        }}
      >
        <div className="border-t border-border px-4 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 text-left text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {auditOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              <ScrollText className="h-3.5 w-3.5" />
              Recent policy decisions
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="pt-2">
              {auditLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading decisions…
                </div>
              ) : auditError ? (
                // A failed audit query is not an empty log — say so.
                <p className="py-1 text-[11px] text-destructive">
                  Couldn&apos;t load policy decisions: {auditError.message}
                </p>
              ) : policyEvents.length === 0 ? (
                <p className="py-1 text-[11px] text-muted-foreground">
                  No policy decisions recorded yet.
                </p>
              ) : (
                <ul className="max-h-64 space-y-1 overflow-y-auto">
                  {policyEvents.map((event) => {
                    const outcome = event.action.slice(
                      POLICY_AUDIT_PREFIX.length,
                    );
                    const meta = extractPolicyMetadata(event.metadata);
                    return (
                      <li
                        key={event._id}
                        className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-[11px]"
                      >
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px]",
                            outcome === "granted"
                              ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                              : outcome === "denied"
                                ? "border-destructive/50 text-destructive"
                                : "border-amber-500/50 text-amber-600 dark:text-amber-400",
                          )}
                        >
                          {outcome}
                        </Badge>
                        {meta.reasonCode ? (
                          <span className="font-mono text-muted-foreground">
                            {meta.reasonCode}
                          </span>
                        ) : meta.code ? (
                          <span className="font-mono text-muted-foreground">
                            {meta.code}
                          </span>
                        ) : null}
                        {meta.policyMode === "unmanaged" && (
                          <span className="text-muted-foreground">bypass</span>
                        )}
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {new Date(event.timestamp).toLocaleString()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      <XAARegistrationWizard
        open={crud.wizardOpen}
        onOpenChange={crud.setWizardOpen}
        organizationId={organizationId}
        editing={crud.editing}
      />

      <RegistrationDeleteDialog
        crud={crud}
        description={
          <>
            The server and its stored credentials are removed, along with the
            Agent&apos;s connection and people assignments for it. Flow
            history is unaffected.
          </>
        }
      />
    </Card>
  );
}
