/** The eval harness applies the same declared policy as the App proxy document. */
import type { WidgetCspMeta } from "./widget-helpers";
import { buildCSP, type SandboxCspSubtypePolicy } from "./sandbox-csp-policy";

export type SandboxProxyCspSubtypePolicy = SandboxCspSubtypePolicy;

export function buildSandboxProxyWidgetCsp(
  cspMeta?: WidgetCspMeta | null,
  cspSubtypePolicy?: SandboxProxyCspSubtypePolicy,
): string {
  // An empty declared policy remains restrictive, including base-uri which
  // WidgetCspMeta does not expose. The harness cannot widen the browser policy.
  return buildCSP({
    connectDomains: cspMeta?.connect_domains ?? [],
    resourceDomains: cspMeta?.resource_domains ?? [],
    frameDomains: cspMeta?.frame_domains ?? [],
    baseUriDomains: [],
  }, undefined, cspSubtypePolicy);
}
