import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { cn } from "@/lib/utils";
import { useHostList, useHostMutations } from "@/hooks/useClients";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import { standardEventProps } from "@/lib/PosthogUtils";
import {
  HOST_TEMPLATES,
  type HostTemplateId,
} from "@/lib/client-templates";
import { CreateClientDialog } from "./CreateClientDialog";

const QUICK_ADD_TEMPLATES: HostTemplateId[] = ["claude", "chatgpt", "copilot"];

const MCPJAM_HOST_NAME = "MCPJam";
const LAST_HOST_DELETE_REASON =
  "A project needs at least one host. Create another host first.";

interface HostOverlayBarProps {
  projectId: string;
  previewedHostId: string | null;
  onChangePreviewedHostId: (hostId: string | null) => void;
  onEditHost: (hostId: string) => void;
  onCanvasReplaceHost?: (hostId: string) => void;
}

export function ClientOverlayBar({
  projectId,
  previewedHostId,
  onChangePreviewedHostId,
  onEditHost,
  onCanvasReplaceHost,
}: HostOverlayBarProps) {
  const posthog = usePostHog();
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { createHost, deleteHost } = useHostMutations();
  const [showCreate, setShowCreate] = useState(false);
  const [createTemplateId, setCreateTemplateId] = useState<HostTemplateId | undefined>(
    undefined,
  );
  const [isDeleting, setIsDeleting] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const mcpjamHost = useMemo(
    () => hosts.find((h) => h.name === MCPJAM_HOST_NAME) ?? null,
    [hosts],
  );

  // Lazily seed a "MCPJam" host with SDK defaults only when the project has
  // no hosts at all. Once any host exists (including after the user deletes
  // MCPJam), we stop seeding — otherwise a deleted MCPJam respawns on every
  // mount and duplicates accumulate.
  const seededRef = useRef(false);
  useEffect(() => {
    if (
      !isAuthenticated ||
      isLoading ||
      hosts.length > 0 ||
      seededRef.current
    ) {
      return;
    }
    seededRef.current = true;
    createHost({
      projectId,
      name: MCPJAM_HOST_NAME,
      input: emptyHostConfigInputV2(),
    }).catch(() => {
      seededRef.current = false;
    });
  }, [isAuthenticated, isLoading, hosts.length, projectId, createHost]);

  const validPreviewedHostId =
    previewedHostId && hosts.some((h) => h.hostId === previewedHostId)
      ? previewedHostId
      : null;
  // Fallback order: previewed → MCPJam (the seeded default) → any host.
  // The third leg matters when the user deletes the MCPJam host while
  // other hosts exist: without it the bar would render its pulsing
  // skeleton indefinitely (seeding skips when `hosts.length > 0`).
  const sortedHosts = useMemo(() => {
    return [...hosts].sort((a, b) => {
      if (a.name === MCPJAM_HOST_NAME) return -1;
      if (b.name === MCPJAM_HOST_NAME) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [hosts]);
  const effectiveHostId =
    validPreviewedHostId ?? mcpjamHost?.hostId ?? sortedHosts[0]?.hostId ?? null;

  useEffect(() => {
    if (isLoading) return;
    if (effectiveHostId == null) return;
    if (previewedHostId === effectiveHostId) return;
    onChangePreviewedHostId(effectiveHostId);
    // When the active host is deleted out from under us (or reconciled
    // away for any other reason) the canvas is still pointing at the
    // dead id. handleChange would call this directly; the non-interactive
    // path needs the same notification or App.hostsTabSelectedHostId
    // stays stale and "Save" targets a deleted id.
    onCanvasReplaceHost?.(effectiveHostId);
  }, [
    isLoading,
    effectiveHostId,
    previewedHostId,
    onChangePreviewedHostId,
    onCanvasReplaceHost,
  ]);

  const activeIndex = useMemo(
    () =>
      effectiveHostId == null
        ? -1
        : sortedHosts.findIndex((h) => h.hostId === effectiveHostId),
    [sortedHosts, effectiveHostId],
  );

  const effectiveHost = activeIndex >= 0 ? sortedHosts[activeIndex] : null;

  const hasFiredOpened = useRef(false);
  useEffect(() => {
    if (hasFiredOpened.current) return;
    hasFiredOpened.current = true;
    posthog.capture("connect_host_overlay_opened", {
      host_count: hosts.length,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posthog]);

  const handleChange = (next: string) => {
    if (next === effectiveHostId) return;
    posthog.capture("connect_host_overlay_swapped", {
      from: effectiveHostId ?? "__unknown__",
      to: next,
      host_count: hosts.length,
    });
    onChangePreviewedHostId(next);
    onCanvasReplaceHost?.(next);
  };

  // Cycle to the prev/next host. Wraps around so the arrows never dead-end —
  // with 2 hosts this turns into a fast toggle.
  const cycle = (direction: 1 | -1) => {
    if (sortedHosts.length <= 1 || activeIndex < 0) return;
    const nextIndex =
      (activeIndex + direction + sortedHosts.length) % sortedHosts.length;
    handleChange(sortedHosts[nextIndex].hostId);
  };

  const handleDelete = async (hostId: string) => {
    const host = hosts.find((h) => h.hostId === hostId);
    if (!host) return;
    setIsDeleting(true);
    try {
      await deleteHost({ hostId });
      toast.success(`Client "${host.name}" deleted`);
      // Telemetry is best-effort: a posthog throw must not bubble into the
      // shared catch and surface a delete-failure toast after the client
      // has already been removed.
      try {
        posthog.capture("client_deleted", {
          ...standardEventProps("chatbox_overlay"),
          client_id: hostId,
          force: false,
        });
      } catch {
        // swallow — analytics must not block the success path
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete client";
      if (msg.includes("consumer")) {
        toast.error(
          `${msg} — use force delete or remove dependent chatboxes/evals first`,
        );
      } else {
        toast.error(msg);
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const openCreateWithTemplate = (templateId?: HostTemplateId) => {
    setCreateTemplateId(templateId);
    setShowCreate(true);
    setMenuOpen(false);
    if (templateId) {
      posthog.capture("connect_host_overlay_quick_add_clicked", {
        template_id: templateId,
      });
    }
  };

  const canCycle = sortedHosts.length > 1;
  const canDelete = sortedHosts.length > 1;
  const arrowDisabled = isLoading || !canCycle;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1"
      data-testid="host-overlay-bar"
    >
      {isLoading || !effectiveHost ? (
        <div className="h-8 w-44 animate-pulse rounded-md bg-muted/50" />
      ) : (
        <div className="flex items-center rounded-md border border-border/40 bg-muted/30">
          <button
            type="button"
            aria-label="Previous host"
            data-testid="host-overlay-prev"
            disabled={arrowDisabled}
            onClick={() => cycle(-1)}
            className={cn(
              "inline-flex h-8 w-7 items-center justify-center rounded-l-md text-muted-foreground transition-colors",
              "hover:bg-muted/60 hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <ChevronLeft className="size-4" />
          </button>

          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Client used for preview"
                data-testid="host-overlay-current"
                className={cn(
                  "flex h-8 min-w-[7rem] max-w-[14rem] items-center justify-center border-x border-border/40 bg-transparent px-3 text-sm font-medium text-foreground transition-colors outline-none",
                  "hover:bg-muted/60 data-[state=open]:bg-muted/60",
                  "focus-visible:ring-2 focus-visible:ring-ring/45",
                )}
              >
                <span className="truncate">{effectiveHost.name}</span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="center"
              className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
            >
              <DropdownMenuRadioGroup
                value={effectiveHostId ?? undefined}
                onValueChange={handleChange}
              >
                {sortedHosts.map((host) => (
                  <DropdownMenuRadioItem
                    key={host.hostId}
                    value={host.hostId}
                    className="group pr-1.5"
                  >
                    <span className="flex-1 truncate">{host.name}</span>
                    <span className="ml-2 flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-data-[highlighted]:opacity-100">
                      <button
                        type="button"
                        aria-label={`Edit ${host.name}`}
                        data-testid={`host-overlay-edit-${host.hostId}`}
                        className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setMenuOpen(false);
                          onEditHost(host.hostId);
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${host.name}`}
                        data-testid={`host-overlay-delete-${host.hostId}`}
                        disabled={isDeleting || !canDelete}
                        title={
                          !canDelete ? LAST_HOST_DELETE_REASON : undefined
                        }
                        className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleDelete(host.hostId);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                data-testid="host-overlay-save-as-new"
                onSelect={() => openCreateWithTemplate(undefined)}
                className="group pr-1.5"
              >
                <Plus className="size-3.5" />
                <span className="flex-1">Add client</span>
                <span
                  className="ml-2 flex shrink-0 items-center gap-0.5"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {QUICK_ADD_TEMPLATES.map((id) => {
                    const template = HOST_TEMPLATES.find((t) => t.id === id);
                    if (!template) return null;
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-label={`Add ${template.label} client`}
                        title={`Add ${template.label}`}
                        data-testid={`host-overlay-quick-add-${id}`}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openCreateWithTemplate(id);
                        }}
                        className={cn(
                          "inline-flex size-6 items-center justify-center rounded-sm transition-colors",
                          "hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
                        )}
                      >
                        <img
                          src={template.logoSrc}
                          alt=""
                          className="size-4 object-contain"
                        />
                      </button>
                    );
                  })}
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            aria-label="Next client"
            data-testid="host-overlay-next"
            disabled={arrowDisabled}
            onClick={() => cycle(1)}
            className={cn(
              "inline-flex h-8 w-7 items-center justify-center rounded-r-md text-muted-foreground transition-colors",
              "hover:bg-muted/60 hover:text-foreground",
              "focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      )}

      <CreateClientDialog
        isOpen={showCreate}
        onClose={() => {
          setShowCreate(false);
          setCreateTemplateId(undefined);
        }}
        projectId={projectId}
        initialTemplateId={createTemplateId}
        onCreated={(hostId) => {
          posthog.capture("connect_host_overlay_saved_as_new", {
            host_id: hostId,
          });
          onChangePreviewedHostId(hostId);
          onEditHost(hostId);
        }}
      />
    </div>
  );
}
