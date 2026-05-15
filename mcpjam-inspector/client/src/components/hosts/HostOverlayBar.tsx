import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
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
import { useHostList, useHostMutations } from "@/hooks/useHosts";
import { emptyHostConfigInputV2 } from "@/lib/host-config-v2";
import { CreateHostDialog } from "./CreateHostDialog";

const MCPJAM_HOST_NAME = "MCPJam";

interface HostOverlayBarProps {
  projectId: string;
  previewedHostId: string | null;
  onChangePreviewedHostId: (hostId: string | null) => void;
  onEditHost: (hostId: string) => void;
}

export function HostOverlayBar({
  projectId,
  previewedHostId,
  onChangePreviewedHostId,
  onEditHost,
}: HostOverlayBarProps) {
  const posthog = usePostHog();
  const { isAuthenticated } = useConvexAuth();
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const { createHost, deleteHost } = useHostMutations();
  const [showCreate, setShowCreate] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const mcpjamHost = useMemo(
    () => hosts.find((h) => h.name === MCPJAM_HOST_NAME) ?? null,
    [hosts],
  );

  // Lazily seed a "MCPJam" host with SDK defaults the first time a project
  // opens Connect without one. Idempotent: only fires when the list has loaded
  // and no MCPJam exists yet.
  const seededRef = useRef(false);
  useEffect(() => {
    if (
      !isAuthenticated ||
      isLoading ||
      mcpjamHost != null ||
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
  }, [isAuthenticated, isLoading, mcpjamHost, projectId, createHost]);

  const validPreviewedHostId =
    previewedHostId && hosts.some((h) => h.hostId === previewedHostId)
      ? previewedHostId
      : null;
  const effectiveHostId = validPreviewedHostId ?? mcpjamHost?.hostId ?? null;

  // Normalize parent state when the persisted previewedHostId is missing or
  // stale (deleted host, fresh project). Fires once after MCPJam appears.
  useEffect(() => {
    if (isLoading) return;
    if (effectiveHostId == null) return;
    if (previewedHostId === effectiveHostId) return;
    onChangePreviewedHostId(effectiveHostId);
  }, [
    isLoading,
    effectiveHostId,
    previewedHostId,
    onChangePreviewedHostId,
  ]);

  const sortedHosts = useMemo(() => {
    return [...hosts].sort((a, b) => {
      if (a.name === MCPJAM_HOST_NAME) return -1;
      if (b.name === MCPJAM_HOST_NAME) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [hosts]);

  const effectiveHost = useMemo(
    () => sortedHosts.find((h) => h.hostId === effectiveHostId) ?? null,
    [sortedHosts, effectiveHostId],
  );

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
  };

  const handleDeleteCurrentHost = async () => {
    if (!effectiveHostId) return;
    const host = hosts.find((h) => h.hostId === effectiveHostId);
    if (!host) return;
    setIsDeleting(true);
    try {
      await deleteHost({ hostId: effectiveHostId });
      toast.success(`Host "${host.name}" deleted`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to delete host";
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

  const menuDisabled = isLoading || sortedHosts.length === 0;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-2 gap-y-2 sm:gap-3"
      data-testid="host-overlay-bar"
    >
      <div className="min-w-[10rem] max-w-[14rem] shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Host used for preview"
              disabled={menuDisabled}
              className={cn(
                "border-input flex h-8 w-full items-center justify-between gap-2 rounded-md border-0 bg-transparent px-2.5 py-2 text-sm font-medium whitespace-nowrap text-foreground shadow-none transition-[color,box-shadow] outline-none",
                "hover:bg-muted/60 data-[state=open]:bg-muted/60",
                "focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring/45",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <span className="truncate">
                {isLoading
                  ? "Loading..."
                  : (effectiveHost?.name ?? "Select host")}
              </span>
              <ChevronDown className="size-4 shrink-0 opacity-55" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
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
                >
                  {host.name}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={!effectiveHostId}
              data-testid="host-overlay-edit"
              onSelect={() => {
                if (effectiveHostId) onEditHost(effectiveHostId);
              }}
            >
              <Pencil className="size-3.5" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="host-overlay-save-as-new"
              onSelect={() => setShowCreate(true)}
            >
              <Plus className="size-3.5" />
              Add
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={!effectiveHostId || isDeleting}
              data-testid="host-overlay-delete"
              onSelect={() => {
                void handleDeleteCurrentHost();
              }}
            >
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <CreateHostDialog
        isOpen={showCreate}
        onClose={() => setShowCreate(false)}
        projectId={projectId}
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
