import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { ExecutionTargetChip } from "@/components/chat-v2/chat-input/execution-target-chip";
import type { LocalStudyController } from "@/hooks/use-local-study-target";

interface LocalStudyControlsProps {
  controller: LocalStudyController;
  chatSessionId: string | null;
  disabled: boolean;
}
export function LocalStudyControls(props: LocalStudyControlsProps) {
  const { controller, chatSessionId, disabled } = props;
  const [open, setOpen] = useState(false);
  const ready = controller.resolveSendTarget(chatSessionId ?? undefined);
  const busy = disabled || controller.loading;
  const target = controller.requested
    ? ready
      ? "local-native"
      : null
    : "hosted";
  const phase = controller.loading
    ? "loading"
    : controller.requested && !ready
    ? "unavailable"
    : "ready";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <ExecutionTargetChip
          readOnly
          target={target}
          phase={phase}
          hostedAvailable={true}
          harnessName={
            ready?.target.harnessId === "codex" ? "Codex" : undefined
          }
        />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !chatSessionId}
          onClick={() => setOpen(true)}
        >
          {controller.requested ? "Local setup" : "Run on this machine"}
        </Button>
        {controller.requested && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={controller.useCloud}
          >
            Use cloud
          </Button>
        )}
        {controller.error && (
          <span role="alert" className="basis-full text-destructive">
            {controller.error}
          </span>
        )}
        {ready && (
          <span className="text-muted-foreground">
            Ready. Send your message to begin.
          </span>
        )}
        {controller.requested &&
          !ready &&
          !controller.loading &&
          !controller.error && (
            <span role="status">
              Authorize this conversation again before sending locally.
            </span>
          )}
      </div>
      <LocalStudyDialog
        open={open}
        onOpenChange={setOpen}
        disabled={busy || !chatSessionId}
        onConfirm={async () => {
          if (chatSessionId) await controller.setup(chatSessionId);
          setOpen(false);
        }}
      />
    </>
  );
}

function LocalStudyDialog({
  open,
  onOpenChange,
  disabled,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled: boolean;
  onConfirm: () => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Run this study on your machine?</DialogTitle>
          <DialogDescription>
            Authorize the study’s configured client for this conversation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            The client runs commands as your OS user in a separate working
            folder for this study. Folder isolation does not restrict its OS
            permissions. The study’s tool approval setting may allow commands without asking again.
          </p>
          <p>
            Model calls use the study’s saved model source and billing. Your
            personal Claude or Codex subscription is not used.
          </p>
          <p>
            Your draft stays here. After setup, press Send to start the client.
            Stop in chat cancels the current turn.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={disabled} onClick={onConfirm}>
            Authorize local preview
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
