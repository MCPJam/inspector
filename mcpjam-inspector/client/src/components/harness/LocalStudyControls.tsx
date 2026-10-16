import type { LocalStudyRevocation } from "@/hooks/use-local-study-revocation";
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
  revocation?: LocalStudyRevocation;
  chatSessionId: string | null;
  disabled: boolean;
  allowSetup?: boolean;
}
export function LocalStudyControls(props: LocalStudyControlsProps) {
  const {
    controller,
    revocation,
    chatSessionId,
    disabled,
    allowSetup = true,
  } = props;
  const [open, setOpen] = useState(false);
  const ready = controller.resolveSendTarget(chatSessionId ?? undefined);
  const busy = disabled || controller.loading || Boolean(revocation?.pending);
  const bound = controller.isBoundConversation(chatSessionId);
  const target =
    controller.requested || bound ? (ready ? "local-native" : null) : "hosted";
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
        {allowSetup && (
          <Button
            variant="ghost"
            size="sm"
            disabled={
              busy || !chatSessionId || Boolean(revocation?.reservationId)
            }
            onClick={() => setOpen(true)}
          >
            {controller.requested ? "Local setup" : "Run on this machine"}
          </Button>
        )}
        {controller.requested && !bound && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => controller.useCloud(chatSessionId)}
          >
            Use cloud
          </Button>
        )}
        <StudyStatus controller={controller} ready={Boolean(ready)} />
        {bound && (
          <span className="text-muted-foreground">
            Start a new conversation to use cloud.
          </span>
        )}
        {revocation && (
          <StudyRevoke
            revocation={revocation}
            reservationId={
              controller.chatSessionId === chatSessionId
                ? controller.ready?.target.localStudySessionId
                : undefined
            }
          />
        )}
      </div>
      <LocalStudyDialog
        open={open}
        onOpenChange={setOpen}
        disabled={busy || !chatSessionId || Boolean(revocation?.reservationId)}
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
            permissions. The study’s tool approval setting may allow commands
            without asking again.
          </p>
          <p>
            Model calls use the study’s saved model source and billing. Your
            personal Claude or Codex subscription is not used.
          </p>
          <p>After setup, press Send to start the client.</p>
          <p>
            Stop cancels the current turn. Revoke local access stops the study
            and removes its local files.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={disabled} onClick={onConfirm}>
            Authorize this conversation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StudyStatus({
  controller,
  ready,
}: {
  controller: LocalStudyController;
  ready: boolean;
}) {
  if (controller.error)
    return (
      <span role="alert" className="basis-full text-destructive">
        {controller.error}
      </span>
    );
  if (ready)
    return (
      <span className="text-muted-foreground">
        Ready. Send your message to begin.
      </span>
    );
  if (controller.requested && !controller.loading)
    return (
      <span role="status">
        Authorize this conversation again before sending locally.
      </span>
    );
  return null;
}
function StudyRevoke({
  revocation,
  reservationId,
}: {
  revocation: LocalStudyRevocation;
  reservationId?: string;
}) {
  if (!reservationId && !revocation.reservationId) return null;
  return (
    <>
      {(!revocation.revoked || !revocation.cleanupComplete) && (
        <Button
          variant="ghost"
          size="sm"
          disabled={revocation.pending}
          title="Stops this study and removes its local files"
          onClick={() => void revocation.revoke(reservationId)}
        >
          {revocation.pending
            ? "Revoking…"
            : revocation.revoked
            ? "Retry cleanup"
            : "Revoke local access"}
        </Button>
      )}
      {revocation.error && (
        <span role="alert" className="basis-full text-destructive">
          {revocation.error}
        </span>
      )}
      {revocation.revoked && (
        <span role="status" className="basis-full text-muted-foreground">
          {revocation.cleanupComplete
            ? "Local access revoked and local files removed. Start a new conversation to run locally again."
            : "Local access revoked. The client has not confirmed stopping; retry cleanup to remove its files."}
        </span>
      )}
    </>
  );
}
