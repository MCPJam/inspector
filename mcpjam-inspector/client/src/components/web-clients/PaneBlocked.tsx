import { KeyRound, Link2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { scopeNavigationTarget } from "@/lib/app-navigation";
import { copyToClipboard } from "@/lib/clipboard";
import { buildHostFocusTabPath } from "@/components/hosts/host-verify-deep-link";
import type { WebAccount } from "@/lib/web-accounts/api";
import {
  webAccountName,
  webAccountWasSignedIn,
  webClientName,
  webClientSite,
} from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";

/**
 * Copies a link to the client's Browser settings, where an admin signs in.
 * Absolute and scoped to this project, because it goes in a message to
 * someone who may have another project open.
 */
export async function copyAdminLink(hostId: string) {
  const path = scopeNavigationTarget(buildHostFocusTabPath(hostId, "browser"));
  if (await copyToClipboard(`${window.location.origin}${path}`))
    toast.success("Link copied. Send it to a project admin.");
  else toast.error("Couldn't copy the link. Try again.");
}

/**
 * The pane for a member when the project has no usable account. MCPJam
 * starts no browser: only a project admin can sign in to a project account,
 * so the pane says why and hands the member a link for an admin.
 */
export function PaneBlocked({
  vendor,
  hostId,
  account,
}: {
  vendor: WebClientVendor;
  hostId: string;
  /** The default account when it needs sign-in; absent when there is none. */
  account?: WebAccount;
}) {
  const client = webClientName(vendor);
  const site = webClientSite(vendor);
  return (
    <div
      role="status"
      data-testid="web-pane-blocked"
      className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <KeyRound className="size-6 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium text-foreground">
        {account
          ? `${webAccountName(account)} needs sign-in`
          : `This project has no ${client} account yet`}
      </p>
      <div className="max-w-sm space-y-2 text-xs text-muted-foreground">
        <p>
          {!account
            ? `Ask a project admin to sign in to ${site} and add a ${client} account.`
            : webAccountWasSignedIn(account)
              ? `${site} signed this account out, so runs on ${client} can't start. Only a project admin can sign in again.`
              : `Ask a project admin to sign in to ${site} with this account.`}
        </p>
        <p>To use your own account, run MCPJam on your computer.</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void copyAdminLink(hostId)}
      >
        <Link2 aria-hidden />
        Copy link for an admin
      </Button>
    </div>
  );
}
