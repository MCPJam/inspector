import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Settings2 } from "lucide-react";
import { useMutation } from "convex/react";
import { toast } from "@/lib/toast";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import { ServerAttachmentPicker } from "@/components/evals/server-attachment-picker";
import type { EvalServerAttachment } from "@/components/evals/types";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useHostList } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { buildHostsPath, useAppNavigate } from "@/lib/app-navigation";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";

/**
 * Publish-tab summary row that mirrors the evals suite header:
 * two compact pills standing in for the chatbox's two pieces of
 * configuration —
 *
 *   - server attachment picker → the same {@link ServerAttachmentPicker}
 *     the evals suite header uses. Picking a named attachment copies its
 *     server set onto the chatbox via `setChatboxServers` (the chatbox
 *     keeps its own chatbox-scoped attachment row; standalone rows are
 *     frozen snapshots, so copy and reference are equivalent). The
 *     selected attachment is derived by matching the chatbox's current
 *     server set against the project's named attachments.
 *   - host pill → switches the previewed host (chatboxes are 1:1 with
 *     hosts). This is the chatbox/swarm host picker; the app-chrome
 *     `HostOverlayBar` is hidden on these routes. Settings still deep-
 *     links to Connect for identity edits.
 */
type ChatboxPublishClientBarProps = {
  chatboxId: string;
  projectId: string;
  hostId: string;
  hostName: string;
  isAuthenticated: boolean;
  currentServerIds: ReadonlyArray<string>;
};

export function ChatboxPublishClientBar({
  chatboxId,
  projectId,
  hostId,
  hostName,
  isAuthenticated,
  currentServerIds,
}: ChatboxPublishClientBarProps) {
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated,
    projectId,
  });

  const setChatboxServers = useMutation(
    "chatboxes:setChatboxServers" as any,
  ) as unknown as (args: {
    chatboxId: string;
    selectedServerIds: string[];
  }) => Promise<{ attachmentId: string }>;

  // The chatbox persists a raw server set (chatbox-scoped attachment row),
  // not a pointer to a named attachment. Derive the "selected" attachment
  // by exact set match so the trigger shows the attachment's name when the
  // chatbox's pick came from one. Standalone attachments are immutable, so
  // a match stays honest over time.
  const matchedAttachmentId = useMemo(() => {
    if (currentServerIds.length === 0) return null;
    const currentSet = new Set(currentServerIds);
    const match = serverAttachments.find(
      (attachment) =>
        attachment.serverIds.length === currentSet.size &&
        attachment.serverIds.every((id) => currentSet.has(id)),
    );
    return match?._id ?? null;
  }, [serverAttachments, currentServerIds]);

  const handleAttachmentChange = async (
    _serverAttachmentId: string,
    attachment: EvalServerAttachment,
  ) => {
    try {
      await setChatboxServers({
        chatboxId,
        selectedServerIds: attachment.serverIds,
      });
      toast.success(
        `Swarm now connects to ${attachment.serverIds.length} server${attachment.serverIds.length === 1 ? "" : "s"} via "${attachment.name}".`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to save servers: ${message}`);
    }
  };

  const serverCount = currentServerIds.length;
  // A non-empty pick that matches no named attachment predates the picker
  // (legacy custom set from the old modal). Label it honestly instead of
  // pretending nothing is picked.
  const emptyTriggerLabel =
    serverCount === 0
      ? "No servers picked"
      : `${serverCount} server${serverCount === 1 ? "" : "s"} · custom pick`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <ServerAttachmentPicker
        projectId={projectId}
        value={matchedAttachmentId}
        onChange={(id, attachment) => void handleAttachmentChange(id, attachment)}
        emptyTriggerLabel={emptyTriggerLabel}
        infoText="A server group is a named set of MCP servers this chatbox connects to."
        selectedDeleteHint="In use by this chatbox — pick another first"
      />

      <ChatboxHostPickerPill
        projectId={projectId}
        isAuthenticated={isAuthenticated}
        hostId={hostId}
        hostName={hostName}
      />
    </div>
  );
}

type ChatboxHostPickerPillProps = {
  projectId: string;
  isAuthenticated: boolean;
  /** Currently displayed host id (from the parent chatbox binding). */
  hostId: string;
  hostName: string;
  className?: string;
};

/**
 * Compact host picker used on chatbox/swarm surfaces. Writes the shared
 * previewed-host pointer so Publish / Sessions / Clusters all follow.
 */
export function ChatboxHostPickerPill({
  projectId,
  isAuthenticated,
  hostId,
  hostName,
  className,
}: ChatboxHostPickerPillProps) {
  const navigate = useAppNavigate();
  const [, setPreviewedHostId] = usePreviewedHostId(projectId);
  const { hosts, isLoading } = useHostList({ isAuthenticated, projectId });
  const [menuOpen, setMenuOpen] = useState(false);

  const sortedHosts = useMemo(
    () => [...hosts].sort((a, b) => a.name.localeCompare(b.name)),
    [hosts],
  );

  // Only publishable clients can be SWITCHED TO from this bar — a standalone
  // Journeys-owned host has no publish surface. Filtered for the dropdown
  // options only; `sortedHosts` (unfiltered) still drives the
  // pointer-validity effect below, so a currently-selected journeys host
  // (the ChatboxesTab "managed by Swarms" notice) is NOT force-redirected
  // away before the user can read the notice.
  const publishableHosts = useMemo(
    () => sortedHosts.filter((h) => h.ownerScope?.type !== "journeys"),
    [sortedHosts],
  );

  // Keep the shared preview pointer honest when the bound host disappears
  // (deleted elsewhere) or was never set — same role HostOverlayBar plays
  // on other tabs.
  useEffect(() => {
    if (isLoading || sortedHosts.length === 0) return;
    const stillValid = sortedHosts.some((h) => h.hostId === hostId);
    if (stillValid) return;
    setPreviewedHostId(sortedHosts[0].hostId);
  }, [isLoading, sortedHosts, hostId, setPreviewedHostId]);

  const logoSrc = resolveHostLogoByDisplayName(hostName);

  const handleSelect = (nextHostId: string) => {
    if (nextHostId === hostId) {
      setMenuOpen(false);
      return;
    }
    track("connect_host_overlay_swapped", {
      location: "chatbox_publish_bar",
      from: hostId,
      to: nextHostId,
      host_count: hosts.length,
    });
    setPreviewedHostId(nextHostId);
    setMenuOpen(false);
  };

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <div
        className={cn(
          "flex h-8 max-w-[280px] items-center rounded-full border border-border/60 bg-muted/40 text-xs font-medium text-foreground",
          className,
        )}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={isLoading || sortedHosts.length === 0}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-full px-2.5 transition hover:bg-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
            title="Switch client"
            aria-label="Switch client"
            data-testid="chatbox-host-picker"
          >
            <span className="shrink-0 text-muted-foreground">Client</span>
            {logoSrc ? (
              <img
                src={logoSrc}
                alt=""
                className="size-3.5 shrink-0 object-contain"
              />
            ) : (
              <span
                aria-hidden
                className="size-3.5 shrink-0 rounded-full bg-muted"
              />
            )}
            <span className="min-w-0 flex-1 truncate text-left">{hostName}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <button
          type="button"
          onClick={() => navigate(buildHostsPath(hostId))}
          className="inline-flex h-full shrink-0 items-center justify-center rounded-r-full border-l border-border/60 px-2 text-muted-foreground transition hover:bg-muted/70 hover:text-foreground"
          title="Edit this client's identity in Connect"
          aria-label="Edit client in Connect"
          data-testid="chatbox-host-edit"
        >
          <Settings2 className="size-3.5" />
        </button>
      </div>
      <DropdownMenuContent align="start" className="min-w-[12rem]">
        {publishableHosts.map((host) => {
          const selected = host.hostId === hostId;
          return (
            <DropdownMenuItem
              key={host.hostId}
              onSelect={() => handleSelect(host.hostId)}
              data-testid={`chatbox-host-option-${host.hostId}`}
            >
              <span className="min-w-0 flex-1 truncate">{host.name}</span>
              {selected ? (
                <Check className="size-3.5 shrink-0 text-foreground" />
              ) : null}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => navigate(buildHostsPath(hostId))}
          data-testid="chatbox-host-open-connect"
        >
          <Settings2 className="size-3.5" />
          Edit in Connect
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
