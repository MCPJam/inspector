/**
 * Iframe sandbox attribute construction (SEP-1865).
 *
 * The renderer's `effectiveSandbox` memo resolves *policy* (host profiles,
 * playground toggles, the capabilities matrix, the hosted clamp) into a
 * resolved `{ csp, permissions, permissive, sandboxAttrs, allowFeatures,
 * cspDirectives }` shape using `@mcpjam/sdk/browser`. That policy resolution
 * stays in the renderer because it depends on inspector-only surface state.
 *
 * What lives here is the deterministic *attribute construction* that turns the
 * resolved policy into the outer iframe's `sandbox=` / `allow=` strings — the
 * exact logic `SandboxedIframe` used to compute inline. Extracted to a
 * dependency-free leaf so both the production renderer (via `SandboxedIframe`)
 * and the eval browser harness build attributes the same way, so a widget
 * renders against an identical grant surface in either host.
 *
 * NOTE: the inner-document CSP `<meta>` is built by the cross-origin sandbox
 * proxy (`server/routes/apps/mcp-apps/sandbox-proxy.html`), not here. PR 3's
 * harness reuses that builder; `resolveIframeSandboxPolicy` is intentionally
 * scoped to the outer attributes the renderer constructs.
 */

/**
 * Minimal structural shape of the resolved widget permissions this module reads
 * — the 4 SEP-1865 spec features, checked only for truthiness. Declared locally
 * rather than importing `McpUiResourcePermissions` from
 * `@modelcontextprotocol/ext-apps` so this leaf stays dependency-free and the
 * published `.d.ts` resolves cleanly for NodeNext consumers (ext-apps's
 * `app-bridge` barrel re-exports types via `export *` that NodeNext can't
 * follow). The real `McpUiResourcePermissions` is structurally assignable to
 * this. (Slice 3 reintroduces an ext-apps dependency where `host-app-bridge`
 * needs `AppBridge` as a value.)
 */
export interface IframeSandboxPermissions {
  camera?: unknown;
  microphone?: unknown;
  geolocation?: unknown;
  clipboardWrite?: unknown;
}

// The 4 SEP-1865 spec permission features (Permissions Policy tokens). Frozen
// spec list; the canonical definition is `SEP_1865_PERMISSION_FEATURES` in
// @mcpjam/sdk (host-config/types). Inlined here so this leaf stays
// dependency-light: the eval browser harness esbuild-bundles this module for
// the Playwright page, and importing the client `client-config-v2` barrel would
// drag Vite-coupled asset/env code into that bundle.
const SEP_1865_PERMISSION_FEATURES = [
  "camera",
  "microphone",
  "geolocation",
  "clipboard-write",
] as const;

/**
 * Spec-mandated permissive baseline for the outer iframe `sandbox=` attribute.
 * Mirrors the default `SandboxedIframe` applies when no profile overrides the
 * token set.
 */
export const DEFAULT_IFRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

/**
 * Build the outer iframe `allow=` (Permissions Policy) attribute.
 *
 * The 4 SEP-1865 spec permissions (camera/microphone/geolocation/
 * clipboard-write) always flow through from `permissions`. When `allowFeatures`
 * is provided (even as `{}`) the profile is authoritative for non-spec
 * Permissions Policy features and the renderer's legacy defaults
 * (`local-network-access *`, `midi *`) are dropped.
 */
export function buildOuterAllowAttribute(input: {
  permissions?: IframeSandboxPermissions;
  allowFeatures?: Record<string, string>;
}): string {
  const { permissions, allowFeatures } = input;
  const allowFeaturesIsAuthoritative = allowFeatures !== undefined;
  const allowList = allowFeaturesIsAuthoritative
    ? []
    : ["local-network-access *", "midi *"];
  if (permissions?.camera) allowList.push("camera *");
  if (permissions?.microphone) allowList.push("microphone *");
  if (permissions?.geolocation) allowList.push("geolocation *");
  if (permissions?.clipboardWrite) allowList.push("clipboard-write *");
  if (allowFeatures) {
    // Defense-in-depth: skip spec features in case the canonicalizer was
    // bypassed. `permissions.allow.{camera,...}` is the single source of truth.
    const specFeatures = new Set<string>(SEP_1865_PERMISSION_FEATURES);
    for (const k of Object.keys(allowFeatures).sort()) {
      if (specFeatures.has(k)) continue;
      const allowlist = allowFeatures[k];
      if (typeof allowlist !== "string" || allowlist.length === 0) continue;
      // Reject `;` and `,` in keys and values — they are the Permissions
      // Policy / HTTP-header separators and would turn the per-feature filter
      // into a directive-injection bypass.
      if (/[;,]/.test(k) || /[;,]/.test(allowlist)) continue;
      // Reject whitespace in the KEY: `"camera *"` would slip past the
      // spec-feature filter and join to `camera * *`, a back-door grant.
      if (/\s/.test(k)) continue;
      allowList.push(`${k} ${allowlist}`);
    }
  }
  return allowList.join("; ");
}

/**
 * Build the outer iframe `sandbox=` attribute.
 *
 * When `sandboxAttrs` is provided (even as `[]`) the profile is authoritative:
 * the iframe gets `allow-scripts allow-same-origin` plus exactly the listed
 * tokens. When undefined, fall back to the permissive `sandbox` baseline.
 * `undefined` vs `[]` is meaningful: `[]` is the explicit "spec-minimum" intent.
 */
export function buildOuterSandboxAttribute(input: {
  sandbox?: string;
  sandboxAttrs?: string[];
}): string {
  const { sandbox = DEFAULT_IFRAME_SANDBOX, sandboxAttrs } = input;
  const tokens = new Set<string>();
  if (sandboxAttrs !== undefined) {
    tokens.add("allow-scripts");
    tokens.add("allow-same-origin");
    for (const t of sandboxAttrs) {
      const trimmed = t.trim();
      if (trimmed.length === 0) continue;
      // Reject internal whitespace: one Set entry that joins to two real
      // sandbox flags would silently widen the grant.
      if (/\s/.test(trimmed)) continue;
      tokens.add(trimmed);
    }
  } else {
    for (const t of sandbox.split(/\s+/)) {
      if (t.length > 0) tokens.add(t);
    }
    // Defense in depth: spec-mandated tokens are always present.
    tokens.add("allow-scripts");
    tokens.add("allow-same-origin");
  }
  return Array.from(tokens).sort().join(" ");
}

/**
 * Resolve the outer iframe sandbox policy into the literal `sandbox=` / `allow=`
 * attribute strings. Consumed by both `SandboxedIframe` (production) and the
 * eval harness so the grant surface is identical in either host.
 */
export function resolveIframeSandboxPolicy(input: {
  sandbox?: string;
  sandboxAttrs?: string[];
  permissions?: IframeSandboxPermissions;
  allowFeatures?: Record<string, string>;
}): { sandbox: string; allow: string } {
  return {
    sandbox: buildOuterSandboxAttribute({
      sandbox: input.sandbox,
      sandboxAttrs: input.sandboxAttrs,
    }),
    allow: buildOuterAllowAttribute({
      permissions: input.permissions,
      allowFeatures: input.allowFeatures,
    }),
  };
}
