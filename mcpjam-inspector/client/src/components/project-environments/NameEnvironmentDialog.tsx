import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
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
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import {
  usePromoteProjectEnvironment,
  type ProjectEnvironmentView,
} from "@/hooks/useProjectEnvironments";
import { convexErrMessage } from "@/lib/convex-error";
import { toast } from "@/lib/toast";

/**
 * Name an ad-hoc environment, promoting it IN PLACE to an ordinary named row.
 *
 * This is the ad-hoc program's escape hatch made visible: ad-hoc rows are
 * content-addressed and therefore immutable, so every surface that shows one —
 * a User Testing scenario, a swarm's "From runs" row — is frozen until the row
 * is named. Promotion keeps the SAME environmentId, so everything pointing at
 * the row (scenarios, suites, historical run session ids) follows it into its
 * named life untouched.
 *
 * `expectedRevision` is captured when the dialog OPENS, per the repo's
 * expectedRevision convention (see `useUpdateProjectEnvironment`): sending the
 * newest reactive revision at submit time would let a stale dialog silently
 * clobber a concurrent promotion. On a rejection the backend's own sentence is
 * shown verbatim — the three CONFLICT causes (already named / row changed /
 * name taken) are distinct instructions to the user, and paraphrasing them
 * into one generic error would erase exactly that.
 */
export interface NameEnvironmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  environment: ProjectEnvironmentView;
  /** After a successful promotion, in addition to the toast + close. */
  onNamed?: (named: ProjectEnvironmentView) => void;
}

export function NameEnvironmentDialog({
  open,
  onOpenChange,
  projectId,
  environment,
  onNamed,
}: NameEnvironmentDialogProps) {
  const promoteEnvironment = usePromoteProjectEnvironment();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // The revision this dialog is editing against. A ref, not derived state:
  // the reactive `environment` prop keeps updating underneath an open dialog,
  // and substituting its fresh revision would defeat the handshake.
  const expectedRevisionRef = useRef(environment.revision);

  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setError(null);
      expectedRevisionRef.current = environment.revision;
    }
    // Capture on OPEN only — `environment.revision` is deliberately not a
    // trigger, so a background change surfaces as the backend's CONFLICT
    // instead of being silently absorbed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !isSaving;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSaving(true);
    setError(null);
    try {
      const named = await promoteEnvironment({
        projectId,
        environmentId: environment.environmentId,
        expectedRevision: expectedRevisionRef.current,
        name: trimmedName,
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      toast.success(
        `Saved as "${trimmedName}" — it is now editable from Environments.`,
      );
      onOpenChange(false);
      onNamed?.(named);
    } catch (err) {
      setError(convexErrMessage(err, "Failed to save the environment."));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && isSaving) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={!isSaving}
        className="gap-4 sm:max-w-md"
        data-testid="name-environment-dialog"
      >
        <DialogHeader className="gap-2 text-left">
          <DialogTitle className="text-foreground">
            Save as environment
          </DialogTitle>
          <DialogDescription>
            This environment was created automatically from a setup, so it
            can&apos;t be edited. Saving it turns it into an ordinary environment
            you can manage from the Environments page — everything already
            running on it follows along.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="name-environment-name">Name</Label>
            <Input
              id="name-environment-name"
              autoComplete="off"
              maxLength={100}
              placeholder="e.g. ChatGPT · staging servers"
              value={name}
              disabled={isSaving}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "name-environment-error" : undefined}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) {
                  e.preventDefault();
                  void handleSubmit();
                }
              }}
              data-testid="name-environment-name-input"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="name-environment-description">
              Description{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <TextareaAutosize
              id="name-environment-description"
              minRows={2}
              maxRows={5}
              maxLength={2000}
              placeholder="What this setup is for…"
              value={description}
              disabled={isSaving}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="name-environment-description-input"
            />
          </div>
          {error ? (
            // The rejection is the dialog's principal feedback channel —
            // `role="alert"` so assistive tech announces it on arrival.
            <p
              id="name-environment-error"
              role="alert"
              className="text-sm text-destructive"
              data-testid="name-environment-error"
            >
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSaving}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
            data-testid="name-environment-submit"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                Saving…
              </>
            ) : (
              "Save as environment"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
