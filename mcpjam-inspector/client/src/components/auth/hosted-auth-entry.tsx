import { useState, type ReactNode } from "react";
import { LoginInitiationRoute } from "./login-initiation-route";

function openApp() {
  window.location.replace("/");
}

/** AuthKit is available here, before Convex or guest-session recovery mounts. */
export function HostedAuthEntry({ children }: { children: ReactNode }) {
  const [isLoginEntry] = useState(
    () => window.location.pathname.replace(/\/+$/, "") === "/login",
  );
  // This is a document entry point. AuthKit leaves the document to sign in;
  // an already-authenticated visitor also reloads so the app providers boot.
  if (isLoginEntry) return <LoginInitiationRoute onAlreadySignedIn={openApp} />;
  return children;
}
