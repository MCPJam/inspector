import { useFeatureFlagEnabled } from "posthog-js/react";
import { HOSTED_MODE } from "@/lib/config";
import {
  HOSTED_BROWSER_FEATURE_FLAG,
  LOCAL_BROWSER_FEATURE_FLAG,
} from "./useComputersEnabled";
import { useHostedBrowserAvailable } from "./useHostedBrowserAvailability";

/**
 * PostHog rollout gate for the WebMCP Inspector — the `/webmcp` nav tab and
 * workspace, and the page-tools section in Playground. Flag off ⇒ invisible, so
 * the surface can roll out per-user without a deploy.
 *
 * Select by deployment, not by the OR used for Browser host authoring:
 * Node/Electron follow local Browser; hosted follows hosted Browser. Neither
 * Computers nor the retired WebMCP flag can expose this surface. Server
 * authentication, runtime readiness, and emergency stops remain independent.
 */
export const WEBMCP_INSPECTOR_FEATURE_FLAG = HOSTED_MODE
  ? HOSTED_BROWSER_FEATURE_FLAG
  : LOCAL_BROWSER_FEATURE_FLAG;

/**
 * Tri-state flag: `true` enabled, `false` explicitly disabled, `undefined`
 * while PostHog is still loading. Route guards must distinguish "disabled" from
 * "not resolved yet", or a direct `/webmcp` cold load bounces a flagged-in user
 * before the flag hydrates (see `WebmcpInspectorRoute`). Anything that only
 * hides UI should use `useWebmcpInspectorEnabled`, which fails closed.
 */
export function useWebmcpInspectorEnabledState(): boolean | undefined {
  const flag = useFeatureFlagEnabled(WEBMCP_INSPECTOR_FEATURE_FLAG);
  // Hosted: the backend's answer, which also knows whether a desktop would
  // come up. A flag-only answer showed the tab on deployments that could not
  // launch it.
  const hosted = useHostedBrowserAvailable("inspector");
  return HOSTED_MODE ? hosted : flag;
}

export function useWebmcpInspectorEnabled(): boolean {
  return useWebmcpInspectorEnabledState() === true;
}
