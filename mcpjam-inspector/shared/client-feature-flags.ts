/**
 * Every PostHog flag key the web client reads. `GET /api/web/flags` evaluates
 * exactly these keys on the server and hands the values to posthog-js as its
 * bootstrap; a key missing here never reaches the client, so its UI stays off.
 *
 * Adding a flag read in client code means adding its key here —
 * client/src/lib/__tests__/feature-flag-allowlist-ratchet.test.ts fails until
 * the two match. (MJ-015)
 */
export const CLIENT_FEATURE_FLAG_KEYS = [
  "billing-entitlements-ui",
  "browser-workspace-enabled",
  "claude-code-host-enabled",
  "codex-host-enabled",
  "computers-enabled",
  "credit-estimate-enabled",
  "cursor-host-enabled",
  "description-experiments-enabled",
  "discord-agent",
  "eval-run-stage-analytics",
  "evaluate-enabled",
  "evaluate-observe-first",
  "guest-credit-wall-copy",
  "hosted-browser-enabled",
  "integrations-tab",
  "learn-more-enabled",
  "local-browser-enabled",
  "local-computer-enabled",
  "local-harness-enabled",
  "mcp-tasks",
  "mcpjam-compatibility",
  "mcpjam-conformance",
  "mcpjam-learning",
  "multi-account-connections-enabled",
  "platform-post-launch",
  "plugins-enabled",
  "pricing-feature-signin-required",
  "project-environments-enabled",
  "registry-enabled",
  "run-disclosure-enabled",
  "sandboxes-enabled",
  "scheduled-evals-enabled",
  "shared-slack-channel-enabled",
  "skills-enabled",
  "slack-agent-org-settings",
  "synthetic-monitors",
  "tool-quality-enabled",
  "trace-destinations",
  "unified-sessions-enabled",
  "unified-share-conformance",
  "unified-share-evals",
  "xaa",
] as const;

export type ClientFeatureFlagKey = (typeof CLIENT_FEATURE_FLAG_KEYS)[number];

export type ClientFeatureFlagValues = Record<string, boolean | string>;

const CLIENT_FEATURE_FLAG_KEY_SET: ReadonlySet<string> = new Set(
  CLIENT_FEATURE_FLAG_KEYS,
);

export function isClientFeatureFlagKey(
  key: string,
): key is ClientFeatureFlagKey {
  return CLIENT_FEATURE_FLAG_KEY_SET.has(key);
}

/**
 * Keep only allowlisted keys whose values have a flag's shape (a boolean, or a
 * variant name). Used on both sides of `/api/web/flags`.
 */
export function pickClientFeatureFlags(
  values: unknown,
): ClientFeatureFlagValues {
  const picked: ClientFeatureFlagValues = {};
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return picked;
  }
  for (const [key, value] of Object.entries(values)) {
    if (!isClientFeatureFlagKey(key)) continue;
    if (typeof value === "boolean" || typeof value === "string") {
      picked[key] = value;
    }
  }
  return picked;
}
