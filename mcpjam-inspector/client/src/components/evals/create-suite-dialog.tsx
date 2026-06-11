import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { useProjectServerAttachments } from "@/hooks/useViews";
import { useHostList } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import {
  ClientAttachmentsEditor,
  type HostAttachmentDraft,
} from "./client-attachments-editor";
import { ServerAttachmentPicker } from "./server-attachment-picker";

export type CreateSuitePayload = {
  name: string;
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
  const [hostAttachments, setHostAttachments] = useState<
    HostAttachmentDraft[]
  >([]);
  const [serverAttachmentId, setServerAttachmentId] = useState<string | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);

  const { isAuthenticated } = useConvexAuth();
  const shouldFetchDefaults = open && hostsEnabled && projectId !== null;
  const { serverAttachments } = useProjectServerAttachments({
    isAuthenticated: isAuthenticated && shouldFetchDefaults,
    projectId: shouldFetchDefaults ? projectId : null,
  });
  const { hosts } = useHostList({
    isAuthenticated: isAuthenticated && shouldFetchDefaults,
    projectId: shouldFetchDefaults ? projectId : null,
  });
  const [previewedHostId] = usePreviewedHostId(
    shouldFetchDefaults ? projectId : null,
  );

  useEffect(() => {
    if (!open) {
      setName("");
      setHostAttachments([]);
      setServerAttachmentId(null);
      setIsSaving(false);
    }
  }, [open]);

  useEffect(() => {
    if (!shouldFetchDefaults) return;
    if (serverAttachmentId === null && serverAttachments.length > 0) {
      setServerAttachmentId(serverAttachments[0]._id);
    }
  }, [shouldFetchDefaults, serverAttachmentId, serverAttachments]);

  useEffect(() => {
    if (!shouldFetchDefaults) return;
    if (hostAttachments.length > 0 || hosts.length === 0) return;
    const preferred =
      hosts.find((h) => h.hostId === previewedHostId) ?? hosts[0];
    setHostAttachments([
      { namedHostId: preferred.hostId, enabledOptionalServerIds: [] },
    ]);
  }, [shouldFetchDefaults, hostAttachments.length, hosts, previewedHostId]);

  const attachmentsRequired = hostsEnabled && projectId !== null;
  const hasRequiredAttachments =
    !attachmentsRequired ||
    (serverAttachmentId !== null && hostAttachments.length > 0);
  const canSubmit =
    name.trim().length > 0 && hasRequiredAttachments && !isSaving;

  const blockReason: string | null = (() => {
    if (canSubmit || isSaving) return null;
    if (name.trim().length === 0) return "Add a suite name first.";
    if (attachmentsRequired && serverAttachmentId === null) {
      return hostAttachments.length === 0
        ? "Attach a server and at least one host first."
        : "Pick a server attachment first.";
    }
    if (attachmentsRequired && hostAttachments.length === 0) {
      return "Attach at least one host first.";
    }
    return null;
  })();

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create suite</DialogTitle>
          <DialogDescription>
            Name your suite and pick what it runs against. You can change
            this later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-foreground">
              Suite name
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Customer support workflows"
            />
          </div>

          {hostsEnabled && projectId ? (
            <div className="divide-y rounded-lg border bg-muted/20">
              <div className="flex items-start justify-between gap-4 p-3">
                <div className="min-w-0 space-y-0.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Servers
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Server set all hosts run against.
                  </p>
                </div>
                <div className="shrink-0">
                  <ServerAttachmentPicker
                    projectId={projectId}
                    value={serverAttachmentId}
                    onChange={setServerAttachmentId}
                    disabled={isSaving}
                  />
                </div>
              </div>
              <div className="space-y-2 p-3">
                <div className="space-y-0.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Hosts
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    Each attached host fans out into its own run.
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
          <Tooltip>
            <TooltipTrigger asChild>
              {/* span wrapper lets the tooltip catch hover/focus even when the button is disabled */}
              <span tabIndex={blockReason ? 0 : -1}>
                <Button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                >
                  {isSaving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Create suite
                </Button>
              </span>
            </TooltipTrigger>
            {blockReason ? (
              <TooltipContent side="top">
                <p className="text-xs">{blockReason}</p>
              </TooltipContent>
            ) : null}
          </Tooltip>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
