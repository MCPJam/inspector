import { useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  ScrollText,
  Trash2,
} from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { Switch } from "@mcpjam/design-system/switch";
import { cn } from "@/lib/utils";
import { LockedIconButton } from "@/components/xaa/registration/XAAResourceAppsSection";
import { useOrgXaaPeople } from "@/hooks/useOrgXaaPeople";
import { useXaaAssignments } from "@/hooks/useXaaAssignments";
import { useXaaManagedConnections } from "@/hooks/useXaaManagedConnections";
import { useXaaResourceApps } from "@/hooks/useXaaResourceApps";
import { useOrganizationAudit } from "@/hooks/useOrganizationAudit";
import {
  effectiveXaaScopes,
  type RemoteOrgXaaPerson,
  type XaaManagedAssignment,
  type XaaManagedConnection,
  type XaaResourceApp,
  type XaaScopeMode,
} from "@/lib/xaa/types";

const LOCKED_REASON = "Only organization admins can manage access.";
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
        onToggle
          ? "cursor-pointer hover:bg-muted/40"
          : "cursor-default",
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

/** One app's access panel: connection toggle, scope ceiling, assignments. */
function AppAccessPanel({
  app,
  connection,
  people,
  peopleLoading,
  canManage,
  onUpsertConnection,
  onUpsertAssignment,
  onRemoveAssignment,
}: {
  app: XaaResourceApp;
  connection: XaaManagedConnection | undefined;
  people: RemoteOrgXaaPerson[];
  /** Roster still resolving — don't claim "everyone is assigned" yet. */
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
}) {
  const [open, setOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const appScopes = app.scopes ?? [];
  const connectionScopes = connection
    ? effectiveXaaScopes(
        connection.scopeMode,
        connection.selectedScopes,
        appScopes,
      )
    : [];

  const peopleById = useMemo(() => {
    const map = new Map<string, RemoteOrgXaaPerson>();
    for (const person of people) map.set(person._id, person);
    return map;
  }, [people]);

  const assignments = connection?.assignments ?? [];
  const unassignedPeople = useMemo(() => {
    const assigned = new Set(assignments.map((a) => a.testIdentityId));
    return people.filter((p) => !assigned.has(p._id));
  }, [assignments, people]);

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

  const statusLabel = !connection
    ? "Not connected"
    : connection.enabled
      ? "Connected"
      : "Disabled";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-testid={`xaa-access-app-${app.id}`}
        className="rounded-md border border-border"
      >
        <div className="flex items-center gap-2 px-3 py-2">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              aria-label={`${open ? "Collapse" : "Expand"} ${app.name}`}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
            >
              {open ? (
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate text-xs font-medium">{app.name}</span>
              <Badge
                variant="outline"
                className={cn(
                  "text-[10px]",
                  connection?.enabled
                    ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
                    : connection
                      ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground",
                )}
              >
                {statusLabel}
              </Badge>
              <span className="text-[11px] text-muted-foreground">
                {assignments.length === 1
                  ? "1 person"
                  : `${assignments.length} people`}
              </span>
            </button>
          </CollapsibleTrigger>
          <Switch
            checked={connection?.enabled === true}
            disabled={!canManage || busy}
            onCheckedChange={(checked) => void setEnabled(checked)}
            aria-label={`Connection for ${app.name}`}
          />
        </div>

        <CollapsibleContent>
          <div className="space-y-3 border-t border-border px-3 py-2.5">
            {!connection ? (
              <p className="text-xs text-muted-foreground">
                The Agent isn&apos;t connected to this app yet. Turn the
                connection on to grant access; runs stay denied until then.
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
                      This app declares no scopes — nothing to select.
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

                <div className="flex items-center gap-2">
                  <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Assigned people
                  </span>
                  {canManage ? (
                    <Popover open={assignOpen} onOpenChange={setAssignOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                        >
                          <Plus className="h-3 w-3" />
                          Assign person
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-64 p-2">
                        {peopleLoading ? (
                          <p className="flex items-center gap-2 px-1 py-0.5 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Loading people…
                          </p>
                        ) : unassignedPeople.length === 0 ? (
                          <p className="px-1 py-0.5 text-xs text-muted-foreground">
                            Everyone is already assigned.
                          </p>
                        ) : (
                          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
                            {unassignedPeople.map((person) => (
                              <li key={person._id}>
                                <button
                                  type="button"
                                  disabled={busy}
                                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted/40"
                                  onClick={() => {
                                    setAssignOpen(false);
                                    void run(() =>
                                      onUpsertAssignment({
                                        connectionId: connection._id,
                                        testIdentityId: person._id,
                                        scopeMode: "all",
                                      }),
                                    );
                                  }}
                                >
                                  <span className="truncate font-medium">
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
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <LockedIconButton
                      label="Assign person"
                      reason={LOCKED_REASON}
                    >
                      <Plus className="h-3 w-3" />
                    </LockedIconButton>
                  )}
                </div>

                {assignments.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    No one is assigned — every managed run against this app is
                    denied.
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
                            {canManage ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Remove ${person?.name ?? "assignment"}`}
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    onRemoveAssignment(assignment._id),
                                  )
                                }
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            ) : (
                              <LockedIconButton
                                label={`Remove ${person?.name ?? "assignment"}`}
                                reason={LOCKED_REASON}
                              >
                                <Trash2 className="h-3 w-3" />
                              </LockedIconButton>
                            )}
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
      </div>
    </Collapsible>
  );
}

/**
 * Access policy per app: whether the Agent is connected, the connection's
 * scope ceiling, and which People may run as — each optionally narrowed to a
 * scope subset. A collapsible footer shows recent policy decisions from the
 * org audit log.
 */
export function XAASetupAccessSection({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const { resourceApps, isLoading: appsLoading } =
    useXaaResourceApps(organizationId);
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
  const error = connectionsError ?? assignmentsError;

  return (
    <Card className="gap-0 p-0">
      <div className="px-4 py-3">
        <h3 className="text-sm font-semibold">Access</h3>
        <p className="truncate text-xs text-muted-foreground">
          Which apps the Agent may reach, and as whom. Denied unless connected
          and assigned.
        </p>
      </div>

      <div className="space-y-1.5 px-4 pb-3">
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading access policy…
          </div>
        ) : resourceApps.length === 0 ? (
          <div
            data-testid="xaa-setup-access-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
          >
            Register a resource app first — access policy is defined per
            registered app.
          </div>
        ) : (
          resourceApps.map((app) => (
            <AppAccessPanel
              key={app.id}
              app={app}
              connection={connectionByAppId.get(app.id)}
              people={people}
              peopleLoading={peopleLoading}
              canManage={canManage}
              onUpsertConnection={upsertConnection}
              onUpsertAssignment={upsertAssignment}
              onRemoveAssignment={removeAssignment}
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
    </Card>
  );
}
