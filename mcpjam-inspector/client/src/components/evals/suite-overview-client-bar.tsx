import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { Globe, MoreHorizontal, Plus, X } from "lucide-react";
import { type HostListItem } from "@/hooks/useClients";
import { navigateApp, routePaths } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";
import type { HostAttachmentDraft } from "./client-attachments-editor";
import type { EvalSuite } from "./types";
import { ServerSetPicker } from "./server-set-picker";

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
  onUpdateServerSet?: (serverSetId: string) => Promise<void>;
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
  onUpdateServerSet,
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
  };

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
      {/* Servers row — suite-level shared server set */}
      {(suite.projectId && (editable || suite.serverSet)) ? (
        <div
          className={cn(
            "flex items-center gap-2 px-1 py-0.5 sm:px-2",
            containerVariant === "inline" && "w-full min-w-0",
          )}
        >
          <span className="shrink-0 text-[11px] text-muted-foreground w-12">
            Servers
          </span>
          {editable && suite.projectId && onUpdateServerSet ? (
            <ServerSetPicker
              projectId={suite.projectId}
              value={suite.serverSetId ?? null}
              onChange={onUpdateServerSet}
            />
          ) : suite.serverSet ? (
            <span className="flex h-8 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground">
              <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              {suite.serverSet.name}
              <span className="text-[10px] text-muted-foreground">
                · {suite.serverSet.serverIds.length} server
                {suite.serverSet.serverIds.length === 1 ? "" : "s"}
              </span>
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Hosts row */}
      <div
        className={cn(
          "flex min-h-9 items-center gap-2 px-1 sm:px-2",
          containerVariant === "inline" &&
            "w-full min-w-0 max-w-full overflow-hidden",
        )}
      >
        {(suite.projectId && (editable || suite.serverSet)) ? (
          <span className="shrink-0 text-[11px] text-muted-foreground w-12">
            Hosts
          </span>
        ) : null}
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
              const label =
                hostNameByAttachment.get(attachment.namedHostId) ??
                projectHosts.find((h) => h.hostId === attachment.namedHostId)
                  ?.name ??
                attachment.namedHostId;
              return (
                <div
                  key={attachment.namedHostId}
                  className="flex h-8 max-w-[260px] shrink-0 items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 text-foreground"
                >
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                    {label}
                  </span>
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
                        <DropdownMenuContent align="start" className="w-52">
                          <DropdownMenuItem onSelect={() => openHostsPage()}>
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
                        onClick={() => void handleRemove(attachment.namedHostId)}
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
    </div>
  );
}
