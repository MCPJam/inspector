import { useState } from "react";
import { useConvexAuth } from "convex/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { cn } from "@/lib/utils";
import { useOrganizationQueries } from "@/hooks/useOrganizations";
import { useXaaResourceApps } from "@/hooks/useXaaResourceApps";
import type { XaaResourceApp } from "@/lib/xaa/types";
import { XAARegistrationWizard } from "./XAARegistrationWizard";

const LOCKED_REASON = "Only organization admins can manage registrations.";

interface XAAResourceAppsSectionProps {
  organizationId: string | null;
  /** Registration currently selected as the flow runner's target. */
  selectedId?: string | null;
  /** Row click — toggles the runner target. */
  onSelect?: (app: XaaResourceApp) => void;
}

/**
 * Edit/delete affordance for non-admins: rendered (so the feature is
 * discoverable) but inert, with a tooltip explaining why. A truly `disabled`
 * button wouldn't fire the tooltip's hover/focus events, hence
 * aria-disabled + no onClick.
 */
function LockedIconButton({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-disabled={true}
          aria-label={label}
          tabIndex={0}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          className="opacity-50"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[14rem] text-center">
        {LOCKED_REASON}
      </TooltipContent>
    </Tooltip>
  );
}

export function XAAResourceAppsSection({
  organizationId,
  selectedId,
  onSelect,
}: XAAResourceAppsSectionProps) {
  // Hooks run unconditionally; the flag/auth gates return null below.
  const registrationEnabled = useFeatureFlagEnabled("xaa-registration");
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const { resourceApps, isLoading, isAuthenticated, remove } =
    useXaaResourceApps(organizationId);
  const { sortedOrganizations } = useOrganizationQueries({
    isAuthenticated: isConvexAuthenticated,
  });

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<XaaResourceApp | null>(null);
  const [pendingDelete, setPendingDelete] = useState<XaaResourceApp | null>(
    null,
  );
  const [isDeleting, setIsDeleting] = useState(false);

  if (registrationEnabled !== true || !isAuthenticated) {
    return null;
  }

  const activeOrg = sortedOrganizations.find((o) => o._id === organizationId);
  const canManage =
    activeOrg?.myRole === "owner" ||
    activeOrg?.myRole === "admin" ||
    activeOrg?.isCreator === true;

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
    <Card className="mx-3 mt-2 mb-1 gap-0 p-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Registered resource apps</h3>
          <p className="truncate text-xs text-muted-foreground">
            Saved targets the flow runner can drive end to end.
          </p>
        </div>
        {canManage ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={openCreate}
          >
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
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading registrations…
          </div>
        ) : resourceApps.length === 0 ? (
          <div
            data-testid="xaa-reg-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
          >
            No resource apps registered yet. Register one to run the full flow
            against it without re-entering config each session.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {resourceApps.map((app) => {
              const isSelected = selectedId === app.id;
              return (
                <li key={app.id}>
                  {/* Row-as-button (it contains real buttons, so the outer
                      can't be a <button>). Click toggles the runner target. */}
                  <div
                    data-testid={`xaa-reg-row-${app.id}`}
                    role={onSelect ? "button" : undefined}
                    tabIndex={onSelect ? 0 : undefined}
                    aria-pressed={onSelect ? isSelected : undefined}
                    onClick={onSelect ? () => onSelect(app) : undefined}
                    onKeyDown={
                      onSelect
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              onSelect(app);
                            }
                          }
                        : undefined
                    }
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2",
                      isSelected
                        ? "border-primary/60 bg-primary/5"
                        : "border-border",
                      onSelect && "cursor-pointer",
                    )}
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
                        {isSelected && (
                          <Badge className="text-[10px]">Run target</Badge>
                        )}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {app.resourceUrl}
                      </div>
                    </div>
                    {canManage ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Edit ${app.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            openEdit(app);
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={`Delete ${app.name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(app);
                          }}
                          onKeyDown={(event) => event.stopPropagation()}
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
              The registration and its stored credentials are removed. Flow
              history is unaffected.
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
