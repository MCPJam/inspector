// Must stay the first import; OAuth modules retain window.fetch at load time.
import "./lib/install-failed-request-tracker";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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
  void import("./app-bootstrap");
}
