/**
 * Server-side CSP adapter for ChatGPT Apps widget routes.
 *
 * Combines the legacy `cspMode` / `openai/widgetCSP` inputs with the
 * host-config `mcpProfile.apps.sandbox.csp` slice. When no host policy is
 * declared the function falls back to `buildCspHeader` exactly as today —
 * preserving widget-derived behavior for users who haven't opted in.
 *
 * When a host policy IS declared, the widget-declared CSP is routed through
 * the shared `resolveSandboxCsp` resolver (mode → restrictTo intersect →
 * deny subtract → hosted clamp), and the resolved domain sets are assembled
 * directly into a CSP header — we do NOT re-route through `buildCspHeader`
 * because that helper unconditionally folds in localhost/wildcard sources
 * that the resolver stripped on purpose (specifically the hosted clamp).
 *
 * Mirrors the MCP-Apps renderer's behavior in
 * `client/.../mcp-apps-renderer.tsx` so advertise and enforce stay in
 * lockstep across protocols.
 */
import {
  resolveSandboxCsp,
  type SandboxCspPolicy,
} from "@mcpjam/sdk";
import {
  buildCspHeader,
  type CspMode,
  type CspConfig,
  type WidgetCspMeta,
} from "./widget-helpers.js";

const DEFAULT_FRAME_ANCESTORS =
  "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*";

/**
 * Origins the hosted-mode sandbox clamp must strip from any widget-
 * declared CSP. Same list the MCP Apps renderer passes into
 * `resolveSandboxCsp` — keep in sync.
 */
const MCPJAM_HOSTED_CLAMP_ORIGINS: ReadonlyArray<string> = [
  "https://*.mcpjam.com",
  "https://mcpjam.com",
];

export interface ResolveWidgetCspArgs {
  /** Legacy `cspMode` value from the request body. */
  cspMode: CspMode;
  /** Widget-declared CSP from `openai/widgetCSP` resource metadata. */
  widgetCsp?: WidgetCspMeta | null;
  /** Host-config sandbox CSP slice from `mcpProfile.apps.sandbox.csp`. */
  sandboxCspPolicy?: SandboxCspPolicy;
  /** Whether the inspector is running in hosted mode. */
  hostedMode: boolean;
  /**
   * frame-ancestors directive to append. Defaults to the localhost set used
   * by the legacy `buildCspHeader`.
   */
  frameAncestors?: string;
  /**
   * Additional origins to strip in hosted mode. Defaults to the MCPJam
   * own-origin list above; tests may pass `[]` to isolate the clamp.
   */
  hostedClampExtraOrigins?: ReadonlyArray<string>;
}

/**
 * Resolve the effective CSP for a ChatGPT Apps widget request.
 *
 * @returns A `CspConfig` shaped exactly like `buildCspHeader` so existing
 * route response shapes (`csp.connectDomains`, `csp.headerString`, etc.)
 * stay unchanged.
 */
export function resolveWidgetCspPolicy(
  args: ResolveWidgetCspArgs,
): CspConfig {
  const frameAncestors = args.frameAncestors ?? DEFAULT_FRAME_ANCESTORS;
  const policyApplies = isPolicyConfigured(args.sandboxCspPolicy);

  // No host policy → preserve historical behavior bit-for-bit. Hosted-mode
  // hard clamp is implicitly skipped here because today's hosted ChatGPT
  // flows opt into a host policy via mcpProfile; nothing in the legacy
  // path expected a same-origin strip.
  if (!policyApplies) {
    return buildCspHeader(args.cspMode, args.widgetCsp, { frameAncestors });
  }

  const widgetMeta = args.widgetCsp ?? {};
  const resolved = resolveSandboxCsp({
    resourceCsp: {
      connectDomains: widgetMeta.connect_domains,
      resourceDomains: widgetMeta.resource_domains,
      frameDomains: widgetMeta.frame_domains,
    },
    policy: args.sandboxCspPolicy,
    // "host-default" baseline falls back to the widget declaration so a
    // user who picks `mode: "host-default"` without a custom baseline gets
    // the resource's own declaration as the starting set — matches the
    // renderer's treatment.
    hostDefaultBaseline: {
      connectDomains: widgetMeta.connect_domains,
      resourceDomains: widgetMeta.resource_domains,
      frameDomains: widgetMeta.frame_domains,
    },
    hostedMode: args.hostedMode,
    hostedClampExtraDeny: args.hostedMode
      ? buildHostedClampDeny(
          args.hostedClampExtraOrigins ?? MCPJAM_HOSTED_CLAMP_ORIGINS,
        )
      : undefined,
  });

  const connectDomains = ["'self'", ...resolved.connectDomains];
  const resourceDomains = [
    "'self'",
    "data:",
    "blob:",
    ...resolved.resourceDomains,
  ];
  const frameDomains = resolved.frameDomains;

  const connectSrc = connectDomains.join(" ");
  const resourceSrc = resourceDomains.join(" ");
  const imgSrc = `'self' data: blob: ${resolved.resourceDomains.join(" ")}`.trim();
  const mediaSrc = imgSrc;
  const frameSrc =
    frameDomains.length > 0
      ? `frame-src ${frameDomains.join(" ")}`
      : "frame-src 'none'";

  const headerString = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${resourceSrc}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    `style-src 'self' 'unsafe-inline' ${resourceSrc}`,
    `img-src ${imgSrc}`,
    `media-src ${mediaSrc}`,
    `font-src 'self' data: ${resourceSrc}`,
    `connect-src ${connectSrc}`,
    frameSrc,
    frameAncestors,
  ].join("; ");

  return {
    // Surfaces the original mode so callers that branch on it stay
    // unchanged. The resolver's effectiveMode lives in resolved.trace if
    // ever needed for debug.
    mode: args.cspMode,
    connectDomains,
    resourceDomains,
    frameDomains,
    headerString,
  };
}

function isPolicyConfigured(policy: SandboxCspPolicy | undefined): boolean {
  if (!policy) return false;
  if (policy.mode !== undefined) return true;
  if (
    policy.restrictTo &&
    Object.values(policy.restrictTo).some(
      (list) => Array.isArray(list) && list.length > 0,
    )
  ) {
    return true;
  }
  if (
    policy.deny &&
    Object.values(policy.deny).some(
      (list) => Array.isArray(list) && list.length > 0,
    )
  ) {
    return true;
  }
  return false;
}

function buildHostedClampDeny(origins: ReadonlyArray<string>) {
  const list = [...origins];
  return {
    connectDomains: list,
    resourceDomains: list,
    frameDomains: list,
    baseUriDomains: list,
  };
}
