import { type ReactElement } from "react";
import { NetworkAccessError } from "./NetworkAccessError";
import { isSessionTokenHostDenied } from "@/lib/session-token";

/**
 * The generic "couldn't establish a session" screen shown at bootstrap for a
 * GENUINE failure (transport error, 5xx, malformed response) — not the expected
 * host-denial 403, which gets `NetworkAccessError` instead.
 *
 * Self-contained inline styles for the same reason as NetworkAccessError: this
 * renders before the app/providers (and their CSS) mount.
 */
export function GenericBootstrapError() {
  return (
    <div
      style={{
        padding: "2rem",
        textAlign: "center",
        fontFamily: "system-ui",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
      }}
    >
      <img
        src="/mcp_jam.svg"
        alt="MCPJam Logo"
        style={{ width: "120px", height: "auto", marginBottom: "1.5rem" }}
      />
      <h1 style={{ color: "#dc2626", marginBottom: "0.5rem" }}>
        Authentication Error
      </h1>
      <p style={{ marginBottom: "0.25rem" }}>
        Failed to establish secure session.
      </p>
      <p style={{ color: "#666", fontSize: "0.875rem" }}>
        This is usually temporary. Retry below, and check the console if it
        persists.
      </p>
      <button
        onClick={() => location.reload()}
        style={{
          marginTop: "1.5rem",
          padding: "0.75rem 1.5rem",
          cursor: "pointer",
          backgroundColor: "#18181b",
          color: "#fff",
          border: "none",
          borderRadius: "0.5rem",
          fontSize: "1rem",
          fontWeight: 500,
        }}
      >
        Restart App
      </button>
    </div>
  );
}

/**
 * Decide what the session-token bootstrap catch should do with an init failure:
 * which screen to render, and whether to report the error.
 *
 * - Expected host-denial 403 (a self-hosted user reaching the inspector over the
 *   network): show `NetworkAccessError`, and do NOT report — these 403s were the
 *   bulk of the Sentry noise this feature set out to remove.
 * - Anything else (transport error, 5xx, malformed response): show the generic
 *   screen AND report, so a real regression isn't invisible.
 *
 * Extracted from `main.tsx` (which self-executes on import and so can't be
 * unit-tested) so this branch — the actual claim of BB-118 — is covered.
 */
export function resolveBootstrapErrorScreen(error: unknown): {
  report: boolean;
  element: ReactElement;
} {
  if (isSessionTokenHostDenied(error)) {
    return { report: false, element: <NetworkAccessError /> };
  }
  return { report: true, element: <GenericBootstrapError /> };
}
