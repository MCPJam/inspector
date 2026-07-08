import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * Master switch for the stateless-MCP / "Auto" protocol feature in the
 * inspector UI (host + per-server protocol dropdowns, and the hosted
 * connect-time Auto default).
 *
 * Backed by the `stateless-mcp-enabled` PostHog flag, but forced on in the
 * dev server so the feature is exercisable locally (including `dev:hosted`)
 * without a PostHog project. Gated on `MODE === "development"` specifically —
 * vitest runs under `MODE === "test"` and production builds under
 * `"production"`, so unit tests keep full control of the flag via their
 * `useFeatureFlagEnabled` mock and prod still honors the real flag.
 */
export function useStatelessMcpEnabled(): boolean {
  const flag = useFeatureFlagEnabled("stateless-mcp-enabled");
  return flag === true || import.meta.env.MODE === "development";
}
