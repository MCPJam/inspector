import { useEffect, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { useWebAccounts } from "@/hooks/use-web-accounts";
import { useWebClientsEnabled } from "@/hooks/useWebClientsEnabled";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";
import {
  runAccountOf,
  webAccountName,
  webClientName,
  webClientSite,
  webClientVendorOfHost,
} from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";
import { PaneBlocked } from "./PaneBlocked";
import { WebAccountChip } from "./WebAccountChip";

/**
 * The web client a signed-in person is previewing in the playground, while
 * the flag is on, and its pane opened by itself the first time a chat shows
 * that client, so a person's close holds. Opening starts no browser.
 */
export function useWebClientPaneOpening({
  hostConfig,
  hostId,
  conversationId,
  signedIn,
}: {
  hostConfig: { harness?: string | null; agentLoop?: string | null } | null;
  hostId: string | null;
  conversationId: string | null;
  signedIn: boolean;
}): WebClientVendor | undefined {
  const enabled = useWebClientsEnabled();
  const vendor =
    enabled && signedIn && hostConfig
      ? webClientVendorOfHost(hostConfig)
      : undefined;
  const openBrowserOnce = useBrowserWorkspaceStore(
    (state) => state.openBrowserOnce,
  );
  // This runs on every mount, so the store remembers which chat and client
  // already opened: a reload or a chat switch must not undo a close.
  useEffect(() => {
    if (vendor && conversationId)
      openBrowserOnce(conversationId, hostId ?? vendor);
  }, [vendor, conversationId, hostId, openBrowserOnce]);
  return vendor;
}

export interface WebClientPaneParts {
  /** Which account the chat runs as, for the pane's top bar. */
  chip: ReactNode;
  /** Shown instead of the browser while no run can use it. */
  blocker: ReactNode;
}

/**
 * The browser pane's parts for Claude web and ChatGPT web, where the
 * vendor's own page is the client; `null` for any other client. The browser
 * body stays out until a run can use it: with a usable account, or on this
 * computer. Until then nothing attaches to a hosted browser, so picking the
 * client costs nothing; runs start the browser on the first send.
 */
export function useWebClientPane({
  projectId,
  hostId,
  vendor,
  local,
}: {
  projectId: string | null;
  hostId: string | null;
  vendor: WebClientVendor | undefined;
  /** This computer's browser, where people sign in with their own account. */
  local: boolean;
}): WebClientPaneParts | null {
  const { accounts, loaded, isAdmin } = useWebAccounts(projectId, vendor);
  if (!vendor || !hostId) return null;
  const account = runAccountOf(accounts);
  const signedOut = account?.status === "needs_sign_in";
  const site = webClientSite(vendor);
  const client = webClientName(vendor);

  let blocker: ReactNode = null;
  if (local || (account && !signedOut)) blocker = null;
  else if (!loaded)
    blocker = (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading accounts…
      </p>
    );
  else if (!isAdmin)
    blocker = <PaneBlocked vendor={vendor} hostId={hostId} account={account} />;
  else
    blocker = (
      <div
        role="status"
        data-testid="web-pane-sign-in"
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <KeyRound className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-foreground">
          {account
            ? `${webAccountName(account)} needs sign-in`
            : `This project has no ${client} account yet`}
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {account
            ? `${site} signed this account out, so runs on ${client} can't start.`
            : `Runs on ${client} can't start until the project has a signed-in ${site} account.`}
        </p>
      </div>
    );

  return {
    chip: (
      <div className="mr-auto flex min-w-0 items-center gap-1">
        <span className="shrink-0 px-1 text-xs font-medium text-foreground">
          {client}
        </span>
        <WebAccountChip
          vendor={vendor}
          hostId={hostId}
          account={account}
          loaded={loaded}
          local={local}
        />
      </div>
    ),
    blocker,
  };
}
