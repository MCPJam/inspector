import { UserRound } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { navigateApp } from "@/lib/app-navigation";
import { buildHostFocusTabPath } from "@/components/hosts/host-verify-deep-link";
import type { WebAccount } from "@/lib/web-accounts/api";
import { webAccountName, webClientName } from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";

/**
 * Above the browser pane: which account this chat runs as. Accounts are
 * managed on the client's Browser settings tab, so the chip opens it.
 */
export function WebAccountChip({
  vendor,
  hostId,
  account,
  loaded = true,
  local = false,
}: {
  vendor: WebClientVendor;
  hostId: string;
  /** The account runs use; absent when the project has none. */
  account?: WebAccount;
  /** Whether the project's accounts have loaded; until then none is known. */
  loaded?: boolean;
  /** The chat runs in this computer's browser with the person's own sign-in. */
  local?: boolean;
}) {
  const name = local
    ? "Your own sign-in"
    : account
      ? webAccountName(account)
      : loaded
        ? "No account yet"
        : "Loading account…";
  const status = local
    ? "This computer"
    : account?.status === "needs_sign_in"
      ? "Needs sign-in"
      : undefined;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 min-w-0 max-w-full gap-1.5 px-2 text-xs"
      aria-label={
        local || account || loaded
          ? `${webClientName(vendor)} account: ${name}${status ? `, ${status}` : ""}. Open Browser settings`
          : `${webClientName(vendor)} account loading. Open Browser settings`
      }
      title="Open Browser settings"
      data-testid="web-account-chip"
      onClick={() => navigateApp(buildHostFocusTabPath(hostId, "browser"))}
    >
      <UserRound className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{name}</span>
      {status ? (
        <span
          className={
            account?.status === "needs_sign_in" && !local
              ? "shrink-0 text-destructive"
              : "shrink-0 text-muted-foreground"
          }
        >
          {status}
        </span>
      ) : null}
    </Button>
  );
}
