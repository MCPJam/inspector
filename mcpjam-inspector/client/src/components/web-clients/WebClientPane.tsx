import { useEffect, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@mcpjam/design-system/button";
import { useWebAccounts } from "@/hooks/use-web-accounts";
import { webAccountsApi } from "@/lib/web-accounts/api";
import {
  saveWebAccountProfile,
  startWebAccountSignIn,
  webAccountFailureMessage,
} from "@/lib/web-accounts/routes";
import { useWebClientsEnabled } from "@/hooks/useWebClientsEnabled";
import { useBrowserWorkspaceStore } from "@/stores/browser-workspace-store";
import {
  newWebAccountLabel,
  runAccountOf,
  webAccountName,
  webAccountWasSignedIn,
  webClientName,
  webClientSite,
  webClientVendorOfHost,
} from "@/lib/web-accounts/clients";
import type { WebClientVendor } from "@/shared/web-clients";
import { PaneBlocked } from "./PaneBlocked";
import { releaseBrowserForChat } from "@/lib/browser-shell/chat-handoff";
import { SaveWebAccountBar } from "./SaveWebAccountBar";
import { WebAccountChip } from "./WebAccountChip";
import { WebSignInBrowser } from "./WebSignInBrowser";

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
  /** A line above the browser while an admin signs in or saves. */
  banner: ReactNode;
  /** Shown instead of the browser while no run can use it. */
  blocker: ReactNode;
}

/**
 * The browser pane's parts for Claude web and ChatGPT web, where the
 * vendor's own page is the client; `null` for any other client. The browser
 * body stays out until a run can use it: with a usable account, or on this
 * computer. Until then nothing attaches to a hosted browser, so picking the
 * client costs nothing; runs start the browser on the first send, and an
 * admin who starts signing in gets a browser of the sign-in's own.
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
  const createAccount = useMutation(webAccountsApi.create);
  // Per client, so switching clients doesn't carry a sign-in over.
  const [signIn, setSignIn] = useState<{
    hostId: string;
    webAccountId: string;
    browserSessionId: string;
    chatSessionId: string;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  if (!vendor || !hostId || !projectId) return null;
  const account = runAccountOf(accounts);
  const signedOut = account?.status === "needs_sign_in";
  // A new account needs sign-in too, but nobody was signed out of it.
  const signedOutBySite = !!account && webAccountWasSignedIn(account);
  const active = signIn?.hostId === hostId && !local ? signIn : null;
  const site = webClientSite(vendor);
  const client = webClientName(vendor);

  // The sign-in route signs in a named account, so a project's first one is
  // made, needing sign-in, before its browser starts.
  const startSignIn = async () => {
    setStarting(true);
    try {
      const webAccountId =
        account?.webAccountId ??
        (
          await createAccount({
            projectId,
            vendor,
            label: newWebAccountLabel(vendor, accounts),
          })
        ).webAccountId;
      const started = await startWebAccountSignIn(projectId, webAccountId);
      setSignIn({
        hostId,
        webAccountId,
        browserSessionId: started.browserSessionId,
        chatSessionId: started.chatSessionId ?? started.browserSessionId,
      });
    } catch (failure) {
      toast.error(
        webAccountFailureMessage(
          failure,
          `Couldn't open a browser to sign in to ${site}. Try again.`,
        ),
      );
    } finally {
      setStarting(false);
    }
  };

  let blocker: ReactNode = null;
  if (active)
    blocker = (
      <WebSignInBrowser
        projectId={projectId}
        chatSessionId={active.chatSessionId}
      />
    );
  else if (local || (account && !signedOut)) blocker = null;
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
          {signedOutBySite
            ? `${site} signed this account out, so runs on ${client} can't start. Sign in again here, then save it for the project.`
            : `Sign in here, then save the account for the project. Nothing is saved until you choose to.`}
        </p>
        <Button
          type="button"
          size="sm"
          disabled={starting}
          onClick={() => void startSignIn()}
        >
          {starting ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {signedOutBySite ? "Sign in again" : "Start signing in"}
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
          loaded={loaded}
          local={local}
        />
      </div>
    ),
    banner: active ? (
      <SaveWebAccountBar
        vendor={vendor}
        expectedEmail={account?.accountEmail}
        onSave={async () => {
          await releaseBrowserForChat(projectId, active.chatSessionId);
          const result = await saveWebAccountProfile(
            projectId,
            active.webAccountId,
            active.browserSessionId,
          );
          if (result.ok) setSignIn(null);
          return result;
        }}
      />
    ) : null,
    blocker,
  };
}
