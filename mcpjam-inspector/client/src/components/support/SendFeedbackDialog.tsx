import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { PlatformFeedbackKind } from "@mcpjam/sdk/platform";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { useSendPlatformFeedback } from "@/hooks/useSendPlatformFeedback";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";

/**
 * Send feedback about MCPJam itself to the MCPJam team.
 *
 * The human form over the same write the `send_feedback` MCP tool and
 * `mcpjam cloud feedback` make. It says, under the form, where the text goes
 * and for how long: a report is read by MCPJam staff outside the user's
 * organization, and the person typing it should know that before they paste.
 *
 * ONE idempotency key per opening. A double-click, or a second press after a
 * slow reply, lands on the first report instead of filing another; opening the
 * dialog again is a new report and mints a new key.
 */
export type SendFeedbackDefaults = {
  kind?: PlatformFeedbackKind;
  summary?: string;
  details?: string;
  operation?: string;
  requestId?: string;
  errorCode?: string;
  projectId?: string;
};

export interface SendFeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaults?: SendFeedbackDefaults;
}

const KIND_OPTIONS: ReadonlyArray<{
  value: PlatformFeedbackKind;
  label: string;
}> = [
  { value: "bug", label: "Something is broken" },
  { value: "missing_capability", label: "Something is missing" },
  { value: "confusing", label: "Something is confusing" },
  { value: "docs", label: "The docs" },
  { value: "other", label: "Something else" },
];

const SUMMARY_MAX = 200;
const DETAILS_MAX = 8000;

function mintKey(): string {
  return crypto.randomUUID();
}

export function SendFeedbackDialog({
  open,
  onOpenChange,
  defaults,
}: SendFeedbackDialogProps) {
  const sendFeedback = useSendPlatformFeedback();
  const [kind, setKind] = useState<PlatformFeedbackKind>("bug");
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const idempotencyKeyRef = useRef(mintKey());

  useEffect(() => {
    if (open) {
      setKind(defaults?.kind ?? "bug");
      setSummary(defaults?.summary ?? "");
      setDetails(defaults?.details ?? "");
      setError(null);
      idempotencyKeyRef.current = mintKey();
    }
    // Reset on OPEN only: `defaults` is read at that moment, and a key minted
    // mid-edit would turn a retry of this report into a second one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmedSummary = summary.trim();
  const canSubmit = trimmedSummary.length > 0 && !isSending;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSending(true);
    setError(null);
    try {
      const receipt = await sendFeedback({
        kind,
        summary: trimmedSummary,
        ...(details.trim() ? { details: details.trim() } : {}),
        ...(defaults?.operation ? { operation: defaults.operation } : {}),
        ...(defaults?.requestId ? { requestId: defaults.requestId } : {}),
        ...(defaults?.errorCode ? { errorCode: defaults.errorCode } : {}),
        ...(defaults?.projectId ? { projectId: defaults.projectId } : {}),
        idempotencyKey: idempotencyKeyRef.current,
      });
      toast.success(
        receipt.duplicate
          ? "Already received, thanks"
          : "Sent to the MCPJam team, thanks",
      );
      onOpenChange(false);
    } catch (err) {
      setError(convexErrMessage(err, "Could not send your feedback."));
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isSending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!isSending}
        className="gap-4 sm:max-w-lg"
        data-testid="send-feedback-dialog"
      >
        <DialogHeader className="gap-2 text-left">
          <DialogTitle className="text-foreground">Send feedback</DialogTitle>
          <DialogDescription>
            Tell the MCPJam team about a problem with MCPJam itself: something
            broken, missing, or confusing.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label id="send-feedback-kind-label">What is it about?</Label>
            <RadioGroup
              aria-labelledby="send-feedback-kind-label"
              value={kind}
              onValueChange={(value) => setKind(value as PlatformFeedbackKind)}
              disabled={isSending}
              className="grid gap-2 sm:grid-cols-2"
            >
              {KIND_OPTIONS.map((option) => {
                const id = `send-feedback-kind-${option.value}`;
                return (
                  <label
                    key={option.value}
                    htmlFor={id}
                    className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                  >
                    <RadioGroupItem id={id} value={option.value} />
                    {option.label}
                  </label>
                );
              })}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label htmlFor="send-feedback-summary">Summary</Label>
            <Input
              id="send-feedback-summary"
              autoComplete="off"
              maxLength={SUMMARY_MAX}
              placeholder="One line: what went wrong or what is missing"
              value={summary}
              disabled={isSending}
              onChange={(e) => setSummary(e.target.value)}
              data-testid="send-feedback-summary"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="send-feedback-details">
              Details{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <TextareaAutosize
              id="send-feedback-details"
              minRows={4}
              maxRows={10}
              maxLength={DETAILS_MAX}
              placeholder="What were you trying to do? What did you expect? What got in the way?"
              value={details}
              disabled={isSending}
              onChange={(e) => setDetails(e.target.value)}
              data-testid="send-feedback-details"
            />
          </div>

          {defaults?.requestId ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="send-feedback-request-id"
            >
              Includes request ID{" "}
              <span className="font-mono">{defaults.requestId}</span>, so the
              team can find the failing request.
            </p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="text-sm text-destructive"
              data-testid="send-feedback-error"
            >
              {error}
            </p>
          ) : null}

          <p className="text-xs text-muted-foreground">
            Sent to the MCPJam team and kept for 180 days. Don&apos;t include
            secrets.
          </p>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            data-testid="send-feedback-submit"
          >
            {isSending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                Sending…
              </>
            ) : (
              "Send feedback"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
