import { useMemo } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import { ServerAttachmentPicker } from "@/components/evals/server-attachment-picker";
import type { EvalServerAttachment } from "@/components/evals/types";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { buildHostsPath, useAppNavigate } from "@/lib/app-navigation";

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
 *   - host pill → navigates to Connect for editing identity (model,
 *     prompt, sandbox). Read-only here per the publish-page contract:
 *     identity edits belong on the Connect tab.
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
  const navigate = useAppNavigate();
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
        `Chatbox now connects to ${attachment.serverIds.length} server${attachment.serverIds.length === 1 ? "" : "s"} via "${attachment.name}".`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to save servers: ${message}`);
    }
  };

  const serverCount = currentServerIds.length;
  const logoSrc = resolveHostLogoByDisplayName(hostName);
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
        infoText="A server attachment is a named set of MCP servers this chatbox connects to. Reuse the same attachment across chatboxes and eval suites, or create one per scenario."
        selectedDeleteHint="In use by this chatbox — pick another first"
      />

      <button
        type="button"
        onClick={() => navigate(buildHostsPath(hostId))}
        className="flex h-8 max-w-[260px] items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 text-xs font-medium text-foreground transition hover:bg-muted/70"
        title="Edit this host's identity in Connect"
      >
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
        <span className="min-w-0 flex-1 truncate">{hostName}</span>
      </button>
    </div>
  );
}
