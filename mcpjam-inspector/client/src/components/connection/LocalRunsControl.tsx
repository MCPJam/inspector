import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { describeConvexFailure } from "@/lib/convex-error";

const COPY = {
  allow: {
    title: "Allow local runs for this server?",
    body: "Members' local apps will receive the project accounts' access tokens. A token already sent keeps working until it expires, even after you stop local runs.",
    action: "Allow local runs",
    done: "Local runs allowed.",
    failed: "Could not allow local runs. Try again.",
  },
  stop: {
    title: "Stop local runs for this server?",
    body: "Members' local apps stop receiving these accounts' tokens from their next connection or run. A token already sent keeps working until it expires.",
    action: "Stop local runs",
    done: "Local runs stopped.",
    failed: "Could not stop local runs. Try again.",
  },
};

/**
 * A project admin's switch for whether members' local apps (npx, the desktop
 * app) may receive a shared server's account tokens. A server shared before
 * this switch existed starts off, because its accounts were shared under the
 * promise that no token leaves MCPJam; the backend refuses local delivery
 * until an admin turns it on. Both directions confirm first.
 */
export function LocalRunsControl({
  allowed,
  onChange,
}: {
  allowed: boolean;
  onChange: (allowed: boolean) => Promise<void>;
}) {
  const switchId = useId();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  // The value just saved, until the refetched `allowed` shows it, so the
  // switch can't offer the same change twice in between.
  const [saved, setSaved] = useState<boolean | null>(null);
  useEffect(() => {
    if (saved === allowed) setSaved(null);
  }, [allowed, saved]);
  const copy = allowed ? COPY.stop : COPY.allow;
  const apply = async () => {
    setSaving(true);
    try {
      await onChange(!allowed);
      setSaved(!allowed);
      toast.success(copy.done);
    } catch (failure) {
      const refusal = describeConvexFailure(failure, copy.failed);
      toast.error(refusal.refusal ? refusal.message : copy.failed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={switchId} className="text-sm font-medium">
          Allow local runs
        </Label>
        <p className="text-xs text-muted-foreground">
          {allowed
            ? "Members' local apps can receive these accounts' access tokens unless your organization's export policy blocks it."
            : "Members' hosted runs use these accounts. Turn this on so their local apps can too."}
        </p>
      </div>
      <Switch
        id={switchId}
        checked={allowed}
        disabled={saving || saved !== null}
        onCheckedChange={() => setConfirming(true)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void apply()}>
              {copy.action}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
