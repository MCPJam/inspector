import { useState } from "react";
import { useMutation } from "convex/react";
import { Globe } from "lucide-react";
import { toast } from "sonner";
import { resolveHostLogoByDisplayName } from "@/lib/chatbox-client-style";
import { AttachmentEditor } from "@/components/clients/attachment-editor";
import { buildClientsPath, useAppNavigate } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";

/**
 * Publish-tab summary row that mirrors the evals suite header:
 * two compact pills standing in for the chatbox's two pieces of
 * configuration —
 *
 *   - server attachment pill → opens the shared {@link AttachmentEditor}
 *     modal (same modal {@link ChatboxServersSection} used to mount)
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
  const [open, setOpen] = useState(false);

  const setChatboxServers = useMutation(
    "chatboxes:setChatboxServers" as any,
  ) as unknown as (args: {
    chatboxId: string;
    selectedServerIds: string[];
  }) => Promise<{ attachmentId: string }>;

  const handleSave = async ({
    selectedServerIds,
  }: {
    selectedServerIds: string[];
  }) => {
    try {
      await setChatboxServers({ chatboxId, selectedServerIds });
      toast.success(
        selectedServerIds.length === 0
          ? "Chatbox saved with no servers — chat sessions will have no tools."
          : `Chatbox now connects to ${selectedServerIds.length} server${selectedServerIds.length === 1 ? "" : "s"}.`,
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`Failed to save servers: ${message}`);
      throw error;
    }
  };

  const serverCount = currentServerIds.length;
  const logoSrc = resolveHostLogoByDisplayName(hostName);
  const empty = serverCount === 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 text-xs font-medium text-foreground transition hover:bg-muted/70",
          empty &&
            "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        )}
        title="Pick which of this project's servers the chatbox connects to"
      >
        <Globe
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            empty && "text-amber-600 dark:text-amber-400",
          )}
        />
        <span>
          {empty
            ? "No servers picked"
            : `${serverCount} server${serverCount === 1 ? "" : "s"}`}
        </span>
      </button>

      <button
        type="button"
        onClick={() => navigate(buildClientsPath(hostId))}
        className="flex h-8 max-w-[260px] items-center gap-1.5 rounded-full border border-border/60 bg-muted/40 px-2.5 text-xs font-medium text-foreground transition hover:bg-muted/70"
        title="Edit this client's identity in Connect"
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

      <AttachmentEditor
        open={open}
        onOpenChange={setOpen}
        scope="chatbox"
        hostId={hostId}
        projectId={projectId}
        isAuthenticated={isAuthenticated}
        selectedServerIds={currentServerIds}
        onSave={handleSave}
      />
    </div>
  );
}
