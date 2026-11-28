import { useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { webClientName, webClientSite } from "@/lib/web-accounts/clients";
import {
  webAccountFailureMessage,
  type SaveProfileResult,
} from "@/lib/web-accounts/routes";
import type { WebClientVendor } from "@/shared/web-clients";

type SaveRefusal = Extract<SaveProfileResult, { ok: false }>["reason"];

/** Why the save didn't happen, and the step that gets it through. */
function refusalText(
  reason: SaveRefusal,
  site: string,
  expectedEmail?: string,
): string {
  switch (reason) {
    case "not_signed_in":
      return `${site} doesn't show a signed-in account yet. Finish signing in, then save again.`;
    case "wrong_account":
      return `The browser is signed in to another ${site} account. Sign in as ${expectedEmail ?? "the account this project uses"}, then save again.`;
    case "version_conflict":
      return "Someone saved this account first. Check it in Browser settings, and sign in again only if it still needs it.";
  }
}

/**
 * While an admin signs in: a deliberate save, because a personal account
 * saved by mistake would serve every member's runs. The site says who is
 * signed in only when the save reads the browser, so the email shows after.
 */
export function SaveWebAccountBar({
  vendor,
  expectedEmail,
  onSave,
}: {
  vendor: WebClientVendor;
  /** The address on record, when this signs an existing account in again. */
  expectedEmail?: string;
  onSave: () => Promise<SaveProfileResult>;
}) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const site = webClientSite(vendor);
  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      const result = await onSave();
      if (result.ok)
        toast.success(`${result.accountEmail} saved for the project.`);
      else setProblem(refusalText(result.reason, site, expectedEmail));
    } catch (failure) {
      setProblem(
        webAccountFailureMessage(
          failure,
          "The account wasn't saved because the request didn't finish. Save again, or start signing in again if the browser closed.",
        ),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      data-testid="save-web-account-bar"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs"
    >
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium text-foreground">
          Sign in to {site} in the browser below, then save it for the project.
        </p>
        {problem ? (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        ) : (
          <p className="text-muted-foreground">
            Once it's saved, members' runs on {webClientName(vendor)} use this
            account.
          </p>
        )}
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
