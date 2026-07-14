import { useMemo, useState } from "react";
import { useConvexAuth } from "convex/react";
import {
  Archive,
  Import,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
} from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import { cn } from "@/lib/utils";
import { CharacterAvatar } from "@/components/chatboxes/personas";
import {
  EMPTY_PERSON_DRAFT,
  PersonForm,
} from "@/components/xaa/XAAPeopleStrip";
import { LockedIconButton } from "@/components/xaa/registration/XAAResourceAppsSection";
import { useOrgXaaPeople } from "@/hooks/useOrgXaaPeople";
import { useXaaManagedConnections } from "@/hooks/useXaaManagedConnections";
import { useProjectQueries } from "@/hooks/useProjects";
import type {
  RemoteOrgXaaPerson,
  XaaImportFromProjectResult,
} from "@/lib/xaa/types";

const LOCKED_REASON = "Only organization admins can manage people.";

function assignedAppsLabel(count: number): string {
  if (count === 0) return "Not assigned to any app";
  return count === 1 ? "Assigned to 1 app" : `Assigned to ${count} apps`;
}

function importSummary(result: XaaImportFromProjectResult): string {
  const parts = [`Imported ${result.imported}`];
  if (result.skippedExisting > 0) {
    parts.push(`${result.skippedExisting} already existed`);
  }
  if (result.skippedOverCap > 0) {
    parts.push(`${result.skippedOverCap} skipped (roster full)`);
  }
  return parts.join(" · ");
}

/**
 * Org roster of synthetic People (grid modeled on the chatboxes Personas
 * tab). Admins add/edit/suspend/archive and import project fixtures; members
 * see the roster read-only. Archived people never reach the wire; suspended
 * ones stay visible but visually parked — the evaluator denies them at mint.
 */
export function XAASetupPeopleSection({
  organizationId,
  canManage,
}: {
  organizationId: string | null;
  canManage: boolean;
}) {
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  const {
    people,
    isLoading,
    error,
    create,
    update,
    setStatus,
    archive,
    importFromProject,
  } = useOrgXaaPeople(organizationId);
  const { connections } = useXaaManagedConnections(organizationId);
  const { sortedProjects } = useProjectQueries({
    isAuthenticated: isConvexAuthenticated,
    organizationId: organizationId ?? undefined,
  });

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] =
    useState<RemoteOrgXaaPerson | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importingProjectId, setImportingProjectId] = useState<string | null>(
    null,
  );
  const [importResult, setImportResult] =
    useState<XaaImportFromProjectResult | null>(null);

  const assignedCountByPerson = useMemo(() => {
    const counts = new Map<string, number>();
    for (const connection of connections) {
      for (const assignment of connection.assignments) {
        counts.set(
          assignment.testIdentityId,
          (counts.get(assignment.testIdentityId) ?? 0) + 1,
        );
      }
    }
    return counts;
  }, [connections]);

  const toggleStatus = async (person: RemoteOrgXaaPerson) => {
    if (busyId) return;
    setBusyId(person._id);
    try {
      await setStatus({
        testIdentityId: person._id,
        status: person.status === "active" ? "suspended" : "active",
      });
    } catch {
      // Surfaced through the hook's `error` state.
    } finally {
      setBusyId(null);
    }
  };

  const confirmArchive = async () => {
    if (!pendingArchive) return;
    setBusyId(pendingArchive._id);
    try {
      await archive({ testIdentityId: pendingArchive._id });
      setPendingArchive(null);
    } catch {
      // Surfaced through the hook's `error` state.
    } finally {
      setBusyId(null);
    }
  };

  const runImport = async (projectId: string) => {
    if (importingProjectId) return;
    setImportingProjectId(projectId);
    setImportResult(null);
    try {
      const result = await importFromProject({ projectId });
      setImportResult(result);
    } catch {
      // Surfaced through the hook's `error` state.
    } finally {
      setImportingProjectId(null);
    }
  };

  return (
    <Card className="gap-0 p-0">
      <div className="flex items-center gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">People</h3>
          <p className="truncate text-xs text-muted-foreground">
            Org-wide synthetic identities, shared across every project.
          </p>
        </div>
        {canManage ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setImportResult(null);
                setImportOpen(true);
              }}
            >
              <Import className="mr-1 h-3.5 w-3.5" />
              Import from project
            </Button>
            <Popover open={adding} onOpenChange={setAdding}>
              <PopoverTrigger asChild>
                <Button type="button" size="sm" variant="outline">
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add person
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-80">
                <PersonForm
                  initial={EMPTY_PERSON_DRAFT}
                  projectId=""
                  onDone={() => setAdding(false)}
                  submitOverride={async (draft) => {
                    await create({
                      name: draft.name,
                      subject: draft.subject,
                      email: draft.email,
                    });
                  }}
                />
              </PopoverContent>
            </Popover>
          </>
        ) : (
          <>
            <LockedIconButton label="Import from project" reason={LOCKED_REASON}>
              <Import className="mr-1 h-3.5 w-3.5" />
              Import from project
            </LockedIconButton>
            <LockedIconButton label="Add person" reason={LOCKED_REASON}>
              <Plus className="mr-1 h-3.5 w-3.5" />
              Add person
            </LockedIconButton>
          </>
        )}
      </div>

      <div className="px-4 pb-3">
        {error ? (
          <p className="pb-2 text-xs text-destructive">{error}</p>
        ) : null}
        {isLoading ? (
          <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading people…
          </div>
        ) : people.length === 0 ? (
          <div
            data-testid="xaa-setup-people-empty"
            className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground"
          >
            No people yet. Add synthetic identities here (or import a
            project&apos;s fixtures) and assign them to apps in the Access
            section.
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {people.map((person) => {
              const suspended = person.status === "suspended";
              const assignedCount =
                assignedCountByPerson.get(person._id) ?? 0;
              return (
                <li key={person._id}>
                  <div
                    data-testid={`xaa-setup-person-${person._id}`}
                    className={cn(
                      "flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5",
                      suspended && "opacity-70",
                    )}
                  >
                    <CharacterAvatar
                      name={person.name}
                      seed={person._id}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-xs font-medium">
                          {person.name}
                        </span>
                        {suspended && (
                          <Badge
                            variant="outline"
                            className="border-amber-500/50 text-[10px] text-amber-600 dark:text-amber-400"
                          >
                            Suspended
                          </Badge>
                        )}
                      </div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {person.subject} · {person.email}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {assignedAppsLabel(assignedCount)}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center">
                      {canManage ? (
                        <>
                          <Popover
                            open={editingId === person._id}
                            onOpenChange={(open) =>
                              setEditingId(open ? person._id : null)
                            }
                          >
                            <PopoverTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                aria-label={`Edit ${person.name}`}
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent align="end" className="w-80">
                              <PersonForm
                                initial={{
                                  name: person.name,
                                  subject: person.subject,
                                  email: person.email,
                                }}
                                personId={person._id}
                                projectId=""
                                subjectLocked
                                onDone={() => setEditingId(null)}
                                submitOverride={async (draft, personId) => {
                                  await update({
                                    testIdentityId: personId!,
                                    name: draft.name,
                                    email: draft.email,
                                  });
                                }}
                              />
                            </PopoverContent>
                          </Popover>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={
                              suspended
                                ? `Reactivate ${person.name}`
                                : `Suspend ${person.name}`
                            }
                            title={
                              suspended
                                ? "Reactivate — allow new ID-JAGs again"
                                : "Suspend — block new ID-JAGs immediately (assignments kept)"
                            }
                            disabled={busyId === person._id}
                            onClick={() => void toggleStatus(person)}
                          >
                            {suspended ? (
                              <Play className="h-3.5 w-3.5" />
                            ) : (
                              <Pause className="h-3.5 w-3.5" />
                            )}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`Archive ${person.name}`}
                            title="Archive — permanent; removes assignments and retires the subject"
                            disabled={busyId === person._id}
                            onClick={() => setPendingArchive(person)}
                          >
                            <Archive className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <>
                          <LockedIconButton
                            label={`Edit ${person.name}`}
                            reason={LOCKED_REASON}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </LockedIconButton>
                          <LockedIconButton
                            label={
                              suspended
                                ? `Reactivate ${person.name}`
                                : `Suspend ${person.name}`
                            }
                            reason={LOCKED_REASON}
                          >
                            {suspended ? (
                              <Play className="h-3.5 w-3.5" />
                            ) : (
                              <Pause className="h-3.5 w-3.5" />
                            )}
                          </LockedIconButton>
                        </>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <Dialog
        open={importOpen}
        onOpenChange={(open) => {
          setImportOpen(open);
          if (!open) setImportResult(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import people from a project</DialogTitle>
            <DialogDescription>
              Copies a project&apos;s test identities into the org roster
              (originals stay in place). People whose subject already exists
              are skipped.
            </DialogDescription>
          </DialogHeader>
          {sortedProjects.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No projects in this organization.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1.5 overflow-y-auto">
              {sortedProjects.map((project) => (
                <li
                  key={project._id}
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2"
                >
                  <span className="min-w-0 flex-1 truncate text-xs font-medium">
                    {project.name}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={importingProjectId !== null}
                    onClick={() => void runImport(project._id)}
                  >
                    {importingProjectId === project._id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      "Import"
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {importResult ? (
            <p className="text-xs text-muted-foreground">
              {importSummary(importResult)}
            </p>
          ) : null}
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Archive {pendingArchive?.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Archiving is permanent: their app assignments are removed and
              the subject stays retired (it can&apos;t be reused by a new
              person). Use Suspend instead to block access temporarily.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void confirmArchive();
              }}
              disabled={busyId !== null}
            >
              {busyId !== null ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
