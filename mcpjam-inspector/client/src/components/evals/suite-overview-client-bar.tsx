import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { AlertCircle, Globe, MoreHorizontal, Plus, X } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { type HostListItem } from "@/hooks/useClients";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";
import { AttachmentEditor } from "@/components/clients/attachment-editor";
import type { HostAttachmentDraft } from "./client-attachments-editor";
import type { EvalSuite } from "./types";

export interface SuiteOverviewHostBarProps {
  suite: EvalSuite;
  /**
   * Hosts available in the suite's project. The parent owns the Convex
   * query (via {@link useHostList}) so this component stays renderable in
   * test environments that don't mount a Convex provider.
   */
  projectHosts: HostListItem[];
  readOnly?: boolean;
  onUpdate?: (attachments: HostAttachmentDraft[]) => Promise<void>;
  /** Merged with the outer bar container (e.g. tighter padding in {@link SuiteHeader}). */
  className?: string;
  /**
   * `panel` = card surface (default). `inline` = no card chrome for embedding
   * in a header row.
   */
  containerVariant?: "panel" | "inline";
}

export function SuiteOverviewClientBar({
  suite,
  projectHosts,
  readOnly = false,
  onUpdate,
  className,
  containerVariant = "panel",
}: SuiteOverviewHostBarProps) {
  const initialAttachments = useMemo<HostAttachmentDraft[]>(
    () =>
      (suite.hostAttachments ?? []).map((attachment) => ({
        namedHostId: attachment.namedHostId,
        enabledOptionalServerIds: attachment.enabledOptionalServerIds,
      })),
    [suite.hostAttachments],
  );

  const [attachments, setAttachments] =
    useState<HostAttachmentDraft[]>(initialAttachments);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  // Per-host AttachmentEditor open-state. Keyed by namedHostId so we
  // can pop the editor for the just-attached host (or any pill the
  // user clicks).
  const [editorOpenHostId, setEditorOpenHostId] = useState<string | null>(
    null,
  );
  const { isAuthenticated } = useConvexAuth();

  // Keep optimistic local state in sync with server-resolved suite data.
  useEffect(() => {
    setAttachments(initialAttachments);
  }, [initialAttachments]);

  const hostNameByAttachment = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const attachment of suite.hostAttachments ?? []) {
      map.set(attachment.namedHostId, attachment.hostName);
    }
    return map;
  }, [suite.hostAttachments]);

  // Version counter so concurrent persists can't race: a stale failure must
  // not roll back state that a newer successful call has already written.
  const persistVersionRef = useRef(0);
  const persist = useCallback(
    async (next: HostAttachmentDraft[]) => {
      if (!onUpdate) return;
      const previous = attachments;
      const myVersion = ++persistVersionRef.current;
      setAttachments(next);
      try {
        await onUpdate(next);
      } catch (error) {
        // Only roll back if no later persist call has been issued since this
        // one started — otherwise we'd clobber a newer optimistic state.
        if (persistVersionRef.current === myVersion) {
          setAttachments(previous);
        }
        console.error("Failed to update suite host attachments", error);
      }
    },
    [attachments, onUpdate],
  );

  const handleAddHost = async (host: HostListItem) => {
    if (readOnly || !onUpdate) return;
    if (attachments.some((a) => a.namedHostId === host.hostId)) {
      setAddMenuOpen(false);
      return;
    }
    await persist([
      ...attachments,
      { namedHostId: host.hostId, enabledOptionalServerIds: [] },
    ]);
    setAddMenuOpen(false);
    // PR B: a freshly-attached host has an empty selection — the eval
    // can't run until the user picks servers. Pop the editor so the
    // picker is the obvious next step.
    setEditorOpenHostId(host.hostId);
  };

  const handleSaveSelection = useCallback(
    async (namedHostId: string, selectedServerIds: string[]) => {
      const next = attachments.map((a) =>
        a.namedHostId === namedHostId
          ? { ...a, enabledOptionalServerIds: selectedServerIds }
          : a,
      );
      await persist(next);
    },
    [attachments, persist],
  );

  const handleRemove = async (namedHostId: string) => {
    if (readOnly || !onUpdate) return;
    await persist(attachments.filter((a) => a.namedHostId !== namedHostId));
  };

  const openHostsPage = () => {
    // No per-host deep-link route exists today; the Hosts page is index-style.
    // When a host-detail route lands, swap this for `buildHostsPath(hostId)`.
    navigateApp(routePaths.clients);
  };

  const editable = Boolean(onUpdate) && !readOnly;
  const attachableHosts = useMemo(
    () =>
      projectHosts.filter(
        (host) => !attachments.some((a) => a.namedHostId === host.hostId),
      ),
    [projectHosts, attachments],
  );

  const addHostMenu = (align: "start" | "end") => (
    <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex h-8 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background px-2.5 text-xs font-medium text-foreground outline-none transition-colors hover:bg-muted/45 focus-visible:ring-2 focus-visible:ring-ring dark:bg-background"
          aria-label="Attach host"
          disabled={!editable}
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Attach host</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className="w-[240px] max-h-64 overflow-y-auto"
        sideOffset={4}
      >
        {attachableHosts.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            All hosts attached
          </div>
        ) : (
          attachableHosts.map((host) => (
            <DropdownMenuItem
              key={host.hostId}
              className="flex cursor-pointer items-center gap-2 text-sm"
              onSelect={() => void handleAddHost(host)}
            >
              <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">{host.name}</span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="cursor-pointer text-sm"
          onSelect={() => {
            setAddMenuOpen(false);
            openHostsPage();
          }}
        >
          Manage hosts…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // The bar always renders (per the empty-state decision in the plan) so the
  // "Attach host" affordance is discoverable even on suites with no hosts.
  return (
    <div
      className={cn(
        containerVariant === "panel"
          ? "rounded-lg bg-card py-2.5 text-card-foreground"
          : "bg-transparent py-0 text-card-foreground",
        className,
      )}
    >
      <div
        className={cn(
          "flex min-h-9 items-center gap-2 px-1 sm:px-2",
          containerVariant === "inline" &&
            "w-full min-w-0 max-w-full overflow-hidden",
        )}
      >
        <div
          className={cn(
            "flex min-w-0 items-center gap-2",
            containerVariant === "panel" ? "flex-1" : "w-full flex-1",
          )}
        >
          <div
            className={cn(
              "flex min-w-0 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              containerVariant === "panel" ? "flex-1" : "min-w-0 flex-1",
            )}
          >
            {attachments.length === 0 ? (
              <span className="shrink-0 text-[13px] font-normal text-muted-foreground">
                No hosts attached
              </span>
            ) : null}

            {attachments.map((attachment) => {
              // Prefer the server-resolved name (catches host renames) and
              // fall back to the project-host-list name, then the id, so the
              // pill never renders empty even during initial load.
              const label =
                hostNameByAttachment.get(attachment.namedHostId) ??
                projectHosts.find((h) => h.hostId === attachment.namedHostId)
                  ?.name ??
                attachment.namedHostId;
              const hasNoServers =
                attachment.enabledOptionalServerIds.length === 0;
              return (
                <div
                  key={attachment.namedHostId}
                  className={cn(
                    "flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border px-2 text-foreground",
                    hasNoServers
                      ? "border-amber-500/50 bg-amber-500/10"
                      : "border-border/60 bg-muted/40",
                  )}
                >
                  {editable ? (
                    <button
                      type="button"
                      onClick={() =>
                        setEditorOpenHostId(attachment.namedHostId)
                      }
                      className="flex min-w-0 flex-1 items-center gap-1 rounded-full px-0.5 text-xs font-medium text-foreground outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Edit servers for ${label}`}
                      title={
                        hasNoServers
                          ? "No servers picked — click to choose from project pool"
                          : "Edit attached servers"
                      }
                    >
                      {hasNoServers ? (
                        <AlertCircle className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                      ) : (
                        <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-left">
                        {label}
                        {hasNoServers ? (
                          <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">
                            · pick servers
                          </span>
                        ) : (
                          <span className="ml-1 text-[10px] text-muted-foreground">
                            · {attachment.enabledOptionalServerIds.length}
                          </span>
                        )}
                      </span>
                    </button>
                  ) : (
                    <>
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                        {label}
                      </span>
                    </>
                  )}
                  {editable ? (
                    <>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                            aria-label={`Client options (${label})`}
                          >
                            <MoreHorizontal className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-52"
                        >
                          <DropdownMenuItem
                            onSelect={() =>
                              setEditorOpenHostId(attachment.namedHostId)
                            }
                          >
                            Edit servers
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => openHostsPage()}
                          >
                            Open in Hosts page
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onSelect={() =>
                              void handleRemove(attachment.namedHostId)
                            }
                          >
                            Remove from suite
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <button
                        type="button"
                        className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                        aria-label={`Remove ${label}`}
                        onClick={() =>
                          void handleRemove(attachment.namedHostId)
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : null}
                </div>
              );
            })}

            {editable ? addHostMenu("end") : null}
          </div>
        </div>
      </div>

      {/* PR B: AttachmentEditor mount. Opens for the host whose pill the
          user clicked (or for the freshly-attached host). One Dialog per
          host so the per-modal local draft doesn't bleed between hosts;
          only one renders at a time. */}
      {editable && suite.projectId
        ? (() => {
            const projectId = suite.projectId;
            return attachments.map((attachment) => (
              <AttachmentEditor
                key={attachment.namedHostId}
                open={editorOpenHostId === attachment.namedHostId}
                onOpenChange={(next) =>
                  setEditorOpenHostId(next ? attachment.namedHostId : null)
                }
                scope="suite"
                hostId={attachment.namedHostId}
                projectId={projectId}
                isAuthenticated={isAuthenticated}
                selectedServerIds={attachment.enabledOptionalServerIds}
                onSave={({ selectedServerIds }) =>
                  handleSaveSelection(
                    attachment.namedHostId,
                    selectedServerIds,
                  )
                }
              />
            ));
          })()
        : null}
    </div>
  );
}
