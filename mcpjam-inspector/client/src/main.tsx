// Must stay the first import; OAuth modules retain window.fetch at load time.
import "./lib/install-failed-request-tracker";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@mcpjam/design-system/button";
import "./index.css";
import { buildElectronMcpCallbackUrl } from "./lib/electron-mcp-callback";
import OAuthDesktopReturnNotice from "./components/oauth/OAuthDesktopReturnNotice";

const electronMcpReturnUrl = buildElectronMcpCallbackUrl();
if (electronMcpReturnUrl) {
  // The browser owns no app session here. Do not initialize auth, Convex,
  // guest sessions or onboarding before handing this result to Electron.
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <OAuthDesktopReturnNotice returnToElectronUrl={electronMcpReturnUrl} />
    </StrictMode>,
  );
} else {
  void import("./app-bootstrap").catch((error: unknown) => {
    console.error("MCPJam app bootstrap failed", error);
    createRoot(document.getElementById("root")!).render(
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
