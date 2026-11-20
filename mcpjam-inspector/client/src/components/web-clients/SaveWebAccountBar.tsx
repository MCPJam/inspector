import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { describeConvexFailure } from "@/lib/convex-error";
import { webClientName, webClientSite } from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";

/**
 * After an admin signs in inside the pane: the account they signed in as,
 * and a deliberate save. Nothing is saved on sign-in, because a personal
 * account saved by mistake would serve every member's runs.
 */
export function SaveWebAccountBar({
  vendor,
  accountEmail,
  onSave,
}: {
  vendor: WebClientVendor;
  accountEmail: string;
  onSave: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await onSave();
      toast.success(`${accountEmail} saved for the project.`);
    } catch (failure) {
      // The backend's own sentence when it refused the save; otherwise ours.
      const fallback = "Couldn't save the account. Try again.";
      const refusal = describeConvexFailure(failure, fallback);
      toast.error(refusal.refusal ? refusal.message : fallback);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      role="status"
      data-testid="save-web-account-bar"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-medium text-foreground">
          Signed in as {accountEmail}
        </p>
        <p className="text-muted-foreground">
          Save it so members' runs on {webClientName(vendor)} can use this{" "}
          {webClientSite(vendor)} account.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={saving}
        onClick={() => void save()}
      >
        {saving ? <Loader2 className="animate-spin" aria-hidden /> : null}
        Save for the project
      </Button>
    </div>
  );
}
