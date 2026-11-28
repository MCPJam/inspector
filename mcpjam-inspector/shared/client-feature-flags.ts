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
  "browser-workspace-enabled",
  "claude-code-host-enabled",
  "client-agent-loop",
  "codex-host-enabled",
  "conformance-tasks-update-check",
  "copilot-cli-harness",
  "credit-estimate-enabled",
  "cursor-host-enabled",
  "description-experiments-enabled",
  "discord-agent",
  "eval-account-selection-enabled",
  "eval-code-evaluators",
  "eval-run-stage-analytics",
  "eval-setup-cleanup-scripts",
  "eval-suite-results-page",
  "eval-suite-settings-tabs",
  "eval-test-case-steps-editor",
  "evaluate-observe-first",
  "evaluate-run-result-pages",
  "evaluator-library",
  "evals-start-recording",
  "guest-credit-wall-copy",
  "home-setup-checklist",
  "hosted-browser-enabled",
  "integrations-tab",
  "learn-more-enabled",
  "local-codex-enabled",
  "local-computer-enabled",
  "local-copilot-cli-enabled",
  "local-cursor-enabled",
  "local-harness-enabled",
  "local-opencode-enabled",
  "mcp-events-enabled",
  "mcp-tasks",
  "mcpjam-compatibility",
  "mcpjam-directory-readiness",
  "mcpjam-learning",
  "mock-servers-enabled",
  "opencode-host-enabled",
  "org-model-gateways",
  "platform-post-launch",
  "playground-multi-model-sessions",
  "plugin-extensions-enabled",
  "plugins-enabled",
  "pricing-feature-signin-required",
  "project-environments-enabled",
  "registry-enabled",
  "run-disclosure-enabled",
  "sandbox-images-enabled",
  "scheduled-evals-enabled",
  "server-canvas",
  "shared-slack-channel-enabled",
  "sidebar-pro-upgrade-card",
  "skills-enabled",
  "slack-agent-org-settings",
  "synthetic-monitors",
  "tool-quality-enabled",
  "trace-cost",
  "trace-destinations",
  "unified-sessions-enabled",
  "unified-share-evals",
  "web-clients-enabled",
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
