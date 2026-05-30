import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  ClientAttachmentsEditor,
  type HostAttachmentDraft,
} from "./client-attachments-editor";
import { ServerAttachmentPicker } from "./server-attachment-picker";

export type CreateSuitePayload = {
  name: string;
  description?: string;
  /**
   * Hosts the suite runs against. Each attachment fans out into its own
   * run on "Run all hosts" — the host's snapshotted config is the source
   * of truth for model, system prompt, temperature, and servers. There is
   * no longer a suite-level flat server list or model override.
   */
  hostAttachments?: HostAttachmentDraft[];
  /** Standalone server attachment shared across all runs of this suite. */
  serverAttachmentId?: string;
};

type CreateSuiteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: CreateSuitePayload) => Promise<void>;
  hostsEnabled?: boolean;
  projectId?: string | null;
};

export function CreateSuiteDialog({
  open,
  onOpenChange,
  onSubmit,
  hostsEnabled = false,
  projectId = null,
}: CreateSuiteDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [hostAttachments, setHostAttachments] = useState<
    HostAttachmentDraft[]
  >([]);
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setHostAttachments([]);
      setServerAttachmentId(null);
      setIsSaving(false);
    }
  }, [open]);

  const canSubmit = name.trim().length > 0 && !isSaving;

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        ...(hostAttachments.length > 0 ? { hostAttachments } : {}),
        ...(serverAttachmentId ? { serverAttachmentId } : {}),
      });
    } catch {
      // onSubmit surfaces its own error toast; keep the dialog open so the
      // user can retry, but don't propagate as an unhandled rejection.
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create suite</DialogTitle>
          <DialogDescription>
            Create a suite, attach clients to run it against, then generate cases
            or import a chat transcript.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground">
              Suite name
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Customer support workflows"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground">
              Description
            </label>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional context for what this suite covers."
            />
          </div>

          {hostsEnabled && projectId ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div>
                  <h3 className="text-sm font-medium text-foreground">Servers</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Pick a named server attachment that all hosts will run
                    against. You can create a new attachment inline or change it
                    later.
                  </p>
                </div>
                <ServerAttachmentPicker
                  projectId={projectId}
                  value={serverAttachmentId}
                  onChange={setServerAttachmentId}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-2">
                <div>
                  <h3 className="text-sm font-medium text-foreground">Clients</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Attach clients to run this suite against. Each attachment fans
                    out into its own run when you click "Run all clients". You can
                    attach more clients later from the suite header.
                  </p>
                </div>
                <ClientAttachmentsEditor
                  projectId={projectId}
                  value={hostAttachments}
                  onChange={setHostAttachments}
                  disabled={isSaving}
                />
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create suite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
