import { HOSTED_MODE } from "@/lib/config";
import { HOSTED_BROWSER_FEATURE_FLAG } from "./useComputersEnabled";
import { useHostedBrowserAvailable } from "./useHostedBrowserAvailability";

/**
 * The WebMCP Inspector — the `/webmcp` nav tab and workspace, and the
 * page-tools section in Playground.
 *
 * Select by deployment: Node/Electron always show it; hosted follows hosted
 * Browser. Neither Computers nor the retired WebMCP flag can expose this
 * surface. Server authentication, runtime readiness, and emergency stops
 * remain independent.
 *
 * This is the key the sidebar resolves the nav item under, so it must stay in
 * `SIDEBAR_RESOLVED_FLAG_KEYS`.
 */
export const WEBMCP_INSPECTOR_FEATURE_FLAG = HOSTED_BROWSER_FEATURE_FLAG;

/**
 * Tri-state: `true` enabled, `false` explicitly disabled, `undefined` while the
 * hosted answer is still loading. Route guards must distinguish "disabled"
 * from "not resolved yet", or a direct `/webmcp` cold load bounces a signed-in
 * user before the answer arrives (see `WebmcpInspectorRoute`). Anything that
 * only hides UI should use `useWebmcpInspectorEnabled`, which fails closed.
 */
export function useWebmcpInspectorEnabledState(): boolean | undefined {
  // Hosted: the backend's answer, which also knows whether a desktop would
  // come up. A flag-only answer showed the tab on deployments that could not
  // launch it.
  const hosted = useHostedBrowserAvailable("inspector");
  return HOSTED_MODE ? hosted : true;
}

export function useWebmcpInspectorEnabled(): boolean {
  return useWebmcpInspectorEnabledState() === true;
}
