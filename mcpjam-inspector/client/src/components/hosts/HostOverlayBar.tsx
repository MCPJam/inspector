import { useEffect, useMemo, useRef, useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Separator } from "@mcpjam/design-system/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
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
  const { createHost } = useHostMutations();
  const [showCreate, setShowCreate] = useState(false);

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

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2"
      data-testid="host-overlay-bar"
    >
      <div className="min-w-[10rem] max-w-[18rem]">
        <Select
          value={effectiveHostId ?? ""}
          onValueChange={handleChange}
          disabled={isLoading || sortedHosts.length === 0}
        >
          <SelectTrigger
            aria-label="Host used for preview"
            size="sm"
            className={cn(
              "h-8 w-full justify-between gap-2 border-0 bg-transparent px-2.5 shadow-none",
              "text-sm font-medium text-foreground",
              "hover:bg-muted/60 data-[state=open]:bg-muted/60",
              "focus-visible:border-transparent focus-visible:ring-2 focus-visible:ring-ring/45",
              "[&_svg:not([class*='text-'])]:opacity-55",
            )}
          >
            <SelectValue
              placeholder={isLoading ? "Loading..." : "Select host"}
            />
          </SelectTrigger>
          <SelectContent>
            {sortedHosts.map((host) => (
              <SelectItem key={host.hostId} value={host.hostId}>
                {host.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Separator
        orientation="vertical"
        className="hidden h-4 shrink-0 bg-border/70 sm:block"
      />

      <div className="flex flex-wrap items-center gap-0.5">
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => {
            if (effectiveHostId) onEditHost(effectiveHostId);
          }}
          disabled={!effectiveHostId}
          data-testid="host-overlay-edit"
        >
          <Pencil className="size-3.5" />
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => setShowCreate(true)}
          data-testid="host-overlay-save-as-new"
        >
          <Plus className="size-3.5" />
          Save as new host…
        </Button>
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
