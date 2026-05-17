import type { HostConfigMcpProfileV1 } from "./host-config-v2";

// Spec-defined sandbox permissions per SEP-1865 §UIResourceMeta.permissions.
// Keys are mcpProfile field names; values are the Permissions-Policy feature
// tokens emitted in the iframe `allow=` attribute.
//
// Used as an allowlist when building the outer Preview-iframe `allow` string:
// any host-config key outside this map is dropped, so a host config that
// somehow contains `{ usbDevices: true }` can't widen the wrapper beyond
// what the spec defines.
const SPEC_FEATURES = {
  camera: "camera",
  microphone: "microphone",
  geolocation: "geolocation",
  clipboardWrite: "clipboard-write",
} as const;

type SpecFeatureKey = keyof typeof SPEC_FEATURES;

/**
 * Build the `allow=` attribute for the outer Chatbox-Preview iframe from the
 * chatbox's host config.
 *
 * Why this exists: Permissions-Policy ratchets at every iframe boundary. The
 * inner mcp-apps renderer (`mcp-apps-renderer.tsx`) already enforces the
 * host's sandbox policy per-resource via `resolveSandboxPermissions`, but if
 * the outer Preview wrapper iframe doesn't grant a feature, no descendant
 * iframe can use it regardless of what the host policy says. Without this,
 * Preview silently shows a blank widget for any UI resource that needs
 * clipboard-write / camera / etc., while Sessions (no outer wrapper) renders
 * the same widget correctly.
 *
 * Security posture:
 *   - Strict allowlist: only the four SEP-1865 features are ever emitted.
 *     Unknown keys in `permissions.allow` are ignored.
 *   - Bare feature tokens default to `'self'` (the iframe's own origin) per
 *     the Permissions-Policy spec — no cross-origin children inherit.
 *   - `deny` always wins, matching the spec's "deny wins" rule.
 *   - Default (undefined / no opt-in): emit the full spec set so the inner
 *     mcp-apps renderer's per-resource gate isn't pre-blocked by the
 *     wrapper. This mirrors the chatbox-surface CSP default of `permissive`
 *     in `mcp-apps-renderer.tsx` — both layers default permissive on
 *     chatbox surfaces and the inner renderer / host config remain the
 *     authoritative enforcement points. Hosts that want strict enforcement
 *     opt in via `apps.sandbox.permissions` (e.g. `mode: "deny-all"` or
 *     a `custom` allow map).
 *   - `deny-all` mode produces an empty string regardless of `allow`.
 *
 * The outer iframe is NOT given a `sandbox=` attribute — it wraps a
 * first-party published-chatbox runtime, and the actual untrusted MCP HTML
 * is two iframes deeper inside the SandboxedIframe proxy that the inner
 * mcp-apps renderer builds per SEP-1865 §Sandbox-proxy.
 */
export function previewIframeAllow(
  profile: HostConfigMcpProfileV1 | undefined,
): string {
  const perms = profile?.apps?.sandbox?.permissions;
  if (perms?.mode === "deny-all") return "";

  // Default ("resource-declared", or no permissions block at all): the
  // inner renderer intersects each resource's declared `_meta.ui.permissions`
  // with the host policy on a per-resource basis. The outer wrapper must
  // pass through the full spec-defined set so we don't pre-block the inner
  // gate; the inner renderer is still the authoritative enforcement point.
  if (!perms || perms.mode === "resource-declared") {
    const denied = new Set(perms?.deny ?? []);
    return Object.values(SPEC_FEATURES)
      .filter((feature) => !denied.has(feature))
      .join("; ");
  }

  // "custom" (or undefined mode with an explicit `allow` map): emit only the
  // spec-defined features the host opted in for, minus anything the host
  // denied. Unknown keys are silently ignored — they can't widen the
  // wrapper.
  const denied = new Set(perms.deny ?? []);
  const enabled: string[] = [];
  for (const key of Object.keys(SPEC_FEATURES) as SpecFeatureKey[]) {
    const feature = SPEC_FEATURES[key];
    if (perms.allow?.[key] && !denied.has(feature)) {
      enabled.push(feature);
    }
  }
  return enabled.join("; ");
}
