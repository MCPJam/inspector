import { useState } from "react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { AttachmentEditor } from "@/components/clients/attachment-editor";

/**
 * PR B: chatbox-side mount of the shared `AttachmentEditor`. Surfaces
 * the chatbox's current server pick + an Edit button. The picker is the
 * same modal the eval-suite `HostAttachmentRow` opens — same flat list
 * of project-pool servers, same empty-selection UX.
 *
 * Save calls `chatboxes:setChatboxServers`, which routes through the
 * shared `writeServerAttachment` chokepoint (allowlist refresh + pin
 * re-materialization happen there).
 */
type ChatboxServersSectionProps = {
  chatboxId: string;
  projectId: string;
  hostId: string;
  isAuthenticated: boolean;
  currentServerIds: ReadonlyArray<string>;
};

export function ChatboxServersSection({
  chatboxId,
  projectId,
  hostId,
  isAuthenticated,
  currentServerIds,
}: ChatboxServersSectionProps) {
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
      const message =
        error instanceof Error ? error.message : String(error);
      toast.error(`Failed to save servers: ${message}`);
      throw error;
    }
  };

  return (
    <section className="rounded-xl border bg-card/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Servers</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick which of this project's servers the chatbox connects to.
            Editing the client's identity (model, prompt) doesn't change
            this — the pick is sticky.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          Edit servers
        </Button>
      </div>
      <div className="mt-3 text-xs">
        {currentServerIds.length === 0 ? (
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300">
            No servers picked. Chat sessions will have no tools until you
            edit and pick at least one.
          </p>
        ) : (
          <p className="text-muted-foreground">
            {currentServerIds.length} server
            {currentServerIds.length === 1 ? "" : "s"} picked.
          </p>
        )}
      </div>
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
    </section>
  );
}
