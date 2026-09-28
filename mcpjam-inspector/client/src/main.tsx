// Must stay the first import; OAuth modules retain window.fetch at load time.
import "./lib/install-failed-request-tracker";
import {
  consumeAccessLinkFromUrl,
  watchForAccessLinks,
} from "./lib/access-link";
import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { appRoot } from "./app-root";
import LoadingScreen from "./components/LoadingScreen";
import { Button } from "@mcpjam/design-system/button";
import "./index.css";
import { buildElectronMcpCallbackUrl } from "./lib/electron-mcp-callback";
import OAuthDesktopReturnNotice from "./components/oauth/OAuthDesktopReturnNotice";
import { Loader2, Circle } from "lucide-react";
import {
  FIRST_RUN_OAUTH_OVERLAY_READY_EVENT,
  getFirstRunOAuthReturnServerName,
} from "./lib/first-run-oauth-return";

function FirstRunOAuthReturnBootScreen({ serverName }: { serverName: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-background p-4 text-foreground">
      <div className="fixed inset-0 bg-overlay backdrop-blur-sm" aria-hidden />
      <div
        className="relative z-10 w-full max-w-[408px] rounded-xl border border-border bg-card p-6"
        role="status"
        aria-label={`Connecting to ${serverName}`}
      >
        <h1 className="text-[17px] leading-6 font-bold tracking-[-0.02em] text-card-foreground">
          Connecting to {serverName}
        </h1>
        <p className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
          Checking the connection before MCPJam opens the playground.
        </p>
        <ol className="mt-5 grid gap-2.5" aria-label="Connection progress">
          {["Connect server", "Negotiate MCP compatibility", "Load tools"].map(
            (label, index) => (
              <li
                key={label}
                className="rounded-md border border-border bg-muted/25 px-3 py-2.5 text-left"
              >
                <div className="flex items-center gap-3">
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                    {index === 0 ? (
                      <Loader2
                        className="size-4 animate-spin text-primary"
                        aria-hidden
                      />
                    ) : (
                      <Circle className="size-3" aria-hidden />
                    )}
                  </span>
                  <span
                    className={
                      index === 0
                        ? "text-[12px] leading-5 font-medium text-card-foreground"
                        : "text-[12px] leading-5 text-muted-foreground"
                    }
                  >
                    {label}
                  </span>
                </div>
              </li>
            ),
          )}
        </ol>
      </div>
    </div>
  );
}

consumeAccessLinkFromUrl();
watchForAccessLinks();

const electronMcpReturnUrl = buildElectronMcpCallbackUrl();
if (electronMcpReturnUrl) {
  // The browser owns no app session here. Do not initialize auth, Convex,
  // guest sessions or onboarding before handing this result to Electron.
  appRoot.render(
    <StrictMode>
      <OAuthDesktopReturnNotice returnToElectronUrl={electronMcpReturnUrl} />
    </StrictMode>,
  );
} else {
  const firstRunOAuthReturnServerName = getFirstRunOAuthReturnServerName();
  let oauthBootRoot: Root | null = null;
  let oauthBootHost: HTMLDivElement | null = null;
  const dismissOAuthBootScreen = () => {
    window.removeEventListener(
      FIRST_RUN_OAUTH_OVERLAY_READY_EVENT,
      dismissOAuthBootScreen,
    );
    oauthBootRoot?.unmount();
    oauthBootHost?.remove();
    oauthBootRoot = null;
    oauthBootHost = null;
  };

  if (firstRunOAuthReturnServerName) {
    oauthBootHost = document.createElement("div");
    oauthBootHost.id = "first-run-oauth-boot-overlay";
    document.body.append(oauthBootHost);
    oauthBootRoot = createRoot(oauthBootHost);
    oauthBootRoot.render(
      <FirstRunOAuthReturnBootScreen
        serverName={firstRunOAuthReturnServerName}
      />,
    );
    window.addEventListener(
      FIRST_RUN_OAUTH_OVERLAY_READY_EVENT,
      dismissOAuthBootScreen,
      { once: true },
    );
  }

  // Keep the callback card in its own root while the real app hydrates below
  // it. The onboarding overlay dismisses that card only after its equivalent
  // connection surface is mounted, avoiding a modal -> loader -> modal flash.
  appRoot.render(<LoadingScreen />);
  void import("./app-bootstrap").catch((error: unknown) => {
    console.error("MCPJam app bootstrap failed", error);
    dismissOAuthBootScreen();
    appRoot.render(
      <div
        role="alert"
        className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-4 text-foreground"
      >
        <p>MCPJam couldn't load. Check your connection and try again.</p>
        <Button onClick={() => window.location.reload()}>Reload MCPJam</Button>
      </div>,
    );
    // Reporting must not prevent recovery if the network also blocks this chunk.
    void import("./lib/error-reporting")
      .then(({ reportCaught }) =>
        reportCaught(error, { source: "app_bootstrap" }),
      )
      .catch(() => {});
  });
}
