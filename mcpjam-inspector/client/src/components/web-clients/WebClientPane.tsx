import { useEffect, useState, type ReactNode } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
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
import { SaveWebAccountBar } from "./SaveWebAccountBar";
import { WebAccountChip } from "./WebAccountChip";

/**
 * The web client a signed-in person is previewing in the playground, while
 * the flag is on, and its pane opened by itself: once per chat and client,
 * so a person's close holds until either changes. Opening starts no browser.
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
  const openBrowser = useBrowserWorkspaceStore((state) => state.openBrowser);
  useEffect(() => {
    if (vendor && conversationId) openBrowser(conversationId);
  }, [vendor, conversationId, hostId, openBrowser]);
  return vendor;
}

export interface WebClientPaneParts {
  /** Which account the chat runs as, for the pane's top bar. */
  chip: ReactNode;
  /** A line above the browser while an admin signs in or saves. */
  banner: ReactNode;
  /** Shown instead of the browser while no run can use it. */
  blocker: ReactNode;
}

/**
 * The browser pane's parts for Claude web and ChatGPT web, where the
 * vendor's own page is the client; `null` for any other client. The browser
 * body stays out until a run can use it: with a usable account, on this
 * computer, or once an admin starts signing in. Until then nothing attaches
 * to a hosted browser, so picking the client costs nothing; runs start the
 * browser on the first send.
 */
export function useWebClientPane({
  projectId,
  hostId,
  vendor,
  local,
  pendingSignIn,
}: {
  projectId: string | null;
  hostId: string | null;
  vendor: WebClientVendor | undefined;
  /** This computer's browser, where people sign in with their own account. */
  local: boolean;
  /** An admin's verified sign-in that isn't saved for the project yet. */
  pendingSignIn?: { accountEmail: string; onSave: () => Promise<void> };
}): WebClientPaneParts | null {
  const { accounts, loaded, isAdmin } = useWebAccounts(projectId, vendor);
  // Per client, so switching clients doesn't carry a sign-in over.
  const [signingInFor, setSigningInFor] = useState<string | null>(null);
  if (!vendor || !hostId) return null;
  const account = runAccountOf(accounts);
  const signedOut = account?.status === "needs_sign_in";
  const signingIn = signingInFor === hostId && !local;
  const site = webClientSite(vendor);
  const client = webClientName(vendor);

  let blocker: ReactNode = null;
  if (local || signingIn || (account && !signedOut)) blocker = null;
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
            ? `Sign in to ${site} as ${webAccountName(account)}`
            : `Sign in to ${site} with your team's test account`}
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          {account
            ? `${site} signed this account out, so runs on ${client} can't start. Sign in again here, then save it for the project.`
            : `Runs on ${client} use a project account. Sign in here, then save it for the project. Nothing is saved until you choose to.`}
        </p>
        <Button type="button" size="sm" onClick={() => setSigningInFor(hostId)}>
          {account ? "Sign in again" : "Start signing in"}
        </Button>
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
          local={local}
        />
      </div>
    ),
    banner: pendingSignIn ? (
      <SaveWebAccountBar
        vendor={vendor}
        accountEmail={pendingSignIn.accountEmail}
        onSave={pendingSignIn.onSave}
      />
    ) : signingIn ? (
      <p className="shrink-0 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        Sign in to {site} in the browser below, then save the account for the
        project.
      </p>
    ) : null,
    blocker,
  };
}
