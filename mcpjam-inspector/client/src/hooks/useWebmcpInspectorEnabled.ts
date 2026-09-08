import { useFeatureFlagEnabled } from "posthog-js/react";

/**
 * PostHog rollout gate for the WebMCP Inspector — the `/webmcp` nav tab and
 * workspace, and the page-tools section in Playground. Flag off ⇒ invisible, so
 * the surface can roll out per-user without a deploy.
 *
 * This is the VISIBILITY gate only. Two other gates sit under it and neither is
 * a substitute: `/api/mcp/*` is mounted only outside hosted mode, and
 * `MCPJAM_WEBMCP_INSPECTOR_ENABLED` is the server-side emergency stop. A
 * flagged-in user on a hosted deployment still gets nothing, which is correct:
 * the browser would have to open on the machine running the inspector.
 *
 * Named `webmcp-inspector-*` rather than `webmcp-*` throughout the code, since
 * `client/src/lib/webmcp/` is the unrelated in-app agent bridge.
 */
export const WEBMCP_INSPECTOR_FEATURE_FLAG = "webmcp-inspector-enabled";

/**
 * Tri-state flag: `true` enabled, `false` explicitly disabled, `undefined`
 * while PostHog is still loading. Route guards must distinguish "disabled" from
 * "not resolved yet", or a direct `/webmcp` cold load bounces a flagged-in user
 * before the flag hydrates (see `WebmcpInspectorRoute`). Anything that only
 * hides UI should use `useWebmcpInspectorEnabled`, which fails closed.
 */
export function useWebmcpInspectorEnabledState(): boolean | undefined {
  return useFeatureFlagEnabled(WEBMCP_INSPECTOR_FEATURE_FLAG);
}

export function useWebmcpInspectorEnabled(): boolean {
  return useWebmcpInspectorEnabledState() === true;
}
