import { useState } from "react";
import { KeyRound, Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import { LockedIconButton } from "@/components/xaa/registration/XAAResourceAppsSection";
import { XAARegistrationWizard } from "@/components/xaa/registration/XAARegistrationWizard";
import { useXaaResourceApps } from "@/hooks/useXaaResourceApps";
import { useXaaManagedConnections } from "@/hooks/useXaaManagedConnections";
import { openXaaAppInDebugger } from "@/lib/app-navigation";
import type { XaaManagedConnection, XaaResourceApp } from "@/lib/xaa/types";

function ConnectionStatusBadge({
  connection,
}: {
  connection: XaaManagedConnection | undefined;
}) {
  if (!connection) {
    return (
      <Badge variant="outline" className="text-[10px] text-muted-foreground">
        Not connected
      </Badge>
    );
  }
  if (!connection.enabled) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400"
      >
        Disabled
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-emerald-500/50 text-[10px] text-emerald-600 dark:text-emerald-400"
    >
      Connected
    </Badge>
  );
}

/**
 * Registered resource apps with their MCPJam Agent connection status.
 * Registration CRUD reuses the debugger's wizard; the connection itself is
 * managed in the Access section — the badge here is a read-only summary.
 */
export function XAASetupAppsSection({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const { resourceApps, isLoading, error, remove } =
    useXaaResourceApps(organizationId);
  const { connectionByAppId } = useXaaManagedConnections(organizationId);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<XaaResourceApp | null>(null);
  const [pendingDelete, setPendingDelete] = useState<XaaResourceApp | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  const openCreate = () => {
    setEditing(null);
    setWizardOpen(true);
  };

  const openEdit = (app: XaaResourceApp) => {
    setEditing(app);
    setWizardOpen(true);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setIsDeleting(true);
    try {
      await remove(pendingDelete.id);
      setPendingDelete(null);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <Card className="gap-0 p-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Apps</h3>
          <p className="truncate text-xs text-muted-foreground">
            Registered resource apps the Agent can be connected to.
          </p>
        </div>
        {canManage ? (
          <Button type="button" size="sm" variant="outline" onClick={openCreate}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Register
          </Button>
        ) : (
          <LockedIconButton label="Register resource app">
            <Plus className="mr-1 h-3.5 w-3.5" />
            Register
          </LockedIconButton>
        )}
      </div>

      <div className="px-4 pb-3">
        {error ? (
          <p className="pb-2 text-xs text-destructive">{error}</p>
        ) : null}
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading registrations…
          </div>
        ) : resourceApps.length === 0 ? (
          <div
            data-testid="xaa-setup-apps-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
          >
            No resource apps registered yet. Register one, then connect the
            Agent to it in the Access section.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {resourceApps.map((app) => {
              const connection = connectionByAppId.get(app.id);
              return (
                <li key={app.id}>
                  <div
                    data-testid={`xaa-setup-app-${app.id}`}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium">
                          {app.name}
                        </span>
                        <Badge variant="secondary" className="text-[10px]">
                          {app.resourceType === "mcp" ? "MCP" : "REST"}
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          {app.authServerMode === "mcpjam"
                            ? "MCPJam AS"
                            : "Own AS"}
                        </Badge>
                        {app.hasSecret && (
                          <KeyRound
                            aria-label="Client secret stored"
                            className="h-3 w-3 text-muted-foreground"
                          />
                        )}
                        <ConnectionStatusBadge connection={connection} />
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {app.resourceUrl}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Test ${app.name} in debugger`}
                      title="Open the debugger with this app selected"
                      onClick={() => openXaaAppInDebugger(app.id)}
                    >
                      <Play className="mr-1 h-3.5 w-3.5" />
                      Test in debugger
                    </Button>
                    {canManage ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${app.name}`}
                          onClick={() => openEdit(app)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${app.name}`}
                          onClick={() => setPendingDelete(app)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    ) : (
                      <>
                        <LockedIconButton label={`Edit ${app.name}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </LockedIconButton>
                        <LockedIconButton label={`Delete ${app.name}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </LockedIconButton>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <XAARegistrationWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        organizationId={organizationId}
        editing={editing}
      />

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {pendingDelete?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The registration and its stored credentials are removed, along
              with the Agent&apos;s connection and assignments for this app.
              Flow history is unaffected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
