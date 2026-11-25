import { useId, useState } from "react";
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
import type { OAuthSharing } from "@/hooks/use-sign-in-sharing";

/** What turning sharing off says, for the project accounts it deletes. */
function stopSharingCopy(accounts: number) {
  const runs = "Members' runs will use their own accounts again.";
  // Turning sharing off deletes every project account the server holds when
  // it commits, including one another admin connected since this list
  // loaded, so the count shown can be short.
  const late =
    "If another admin connected a project account since this list loaded, MCPJam deletes it";
  if (accounts === 0) {
    return {
      title: "Stop sharing this server's sign-in?",
      body: `${runs} ${late}.`,
      action: "Stop sharing",
    };
  }
  const one = accounts === 1;
  return {
    title: one
      ? "Stop sharing and delete the project account?"
      : `Stop sharing and delete ${accounts} project accounts?`,
    body: `MCPJam will delete ${one ? "it" : "them"} and ask the sign-in provider to revoke ${one ? "its token" : "their tokens"}. ${runs} ${late} too. This cannot be undone.`,
    action: "Delete and stop sharing",
  };
}

/**
 * A project admin's switch between each member signing in with their own
 * accounts and one sign-in shared with the project, where admins connect up
 * to 8 project accounts for every member's runs.
 *
 * Both directions confirm first. Sharing lets every member's runs act as the
 * accounts, including from their local apps, which receive the accounts'
 * access tokens; turning it off deletes them, which the backend does as part
 * of the same write. Local runs on a shared server have their own switch
 * (`LocalRunsControl`).
 */
export function SignInSharingControl({
  shared,
  accountCount,
  onChange,
}: {
  shared: boolean;
  /** The project accounts listed below it, which turning sharing off deletes. */
  accountCount: number;
  onChange: (sharing: OAuthSharing) => Promise<void>;
}) {
  const switchId = useId();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const stop = stopSharingCopy(accountCount);
  const apply = async () => {
    setSaving(true);
    const failed = shared
      ? "Could not stop sharing this server's sign-in. Try again."
      : "Could not share this server's sign-in. Try again.";
    try {
      await onChange(shared ? "personal" : "shared");
      toast.success(
        !shared
          ? "Sign-in shared with the project."
          : accountCount
            ? "Sign-in no longer shared, and the project accounts were deleted."
            : "Sign-in no longer shared.",
      );
    } catch (failure) {
      // The backend's own sentence when it refused; otherwise ours.
      const refusal = describeConvexFailure(failure, failed);
      toast.error(refusal.refusal ? refusal.message : failed);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
      <div className="space-y-0.5">
        <Label htmlFor={switchId} className="text-sm font-medium">
          {shared
            ? "Shared with the project"
            : "Share sign-in with the project"}
        </Label>
        <p className="text-xs text-muted-foreground">
          {shared
            ? "Members' hosted runs act as the project accounts. Local runs follow the switch below."
            : "Admins connect up to 8 accounts that every member's runs can act as, in MCPJam and in their local apps."}
        </p>
      </div>
      <Switch
        id={switchId}
        checked={shared}
        disabled={saving}
        onCheckedChange={() => setConfirming(true)}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {shared
                ? stop.title
                : "Share this server's sign-in with the project?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {shared
                ? stop.body
                : "Members' local apps will receive the access tokens of the accounts admins connect here. A token already sent keeps working until it expires. Members' own accounts on this server aren't used while sharing is on."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                shared && accountCount
                  ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  : undefined
              }
              onClick={() => void apply()}
            >
              {shared ? stop.action : "Share sign-in"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
