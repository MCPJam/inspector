import { DEFAULT_RETRY_POLICY, type RetryPolicy } from "@mcpjam/sdk";

// One retry absorbs the dominant hosted-connect failure mode: a stale
// keep-alive socket (undici pools per-origin; many MCP servers close idle
// sockets after ~5s) dies instantly with ECONNRESET/"fetch failed" and
// succeeds on a fresh connection. The manager applies this policy to
// `connectToServer` only — per-request operations keep their own opt-in
// retry — and `isRetryableTransientError` already excludes auth failures
// and deliberate non-retryable verdicts. The delay stays short because
// these routes are interactive: the user is watching a connect spinner.
export const INSPECTOR_MCP_RETRY_POLICY: RetryPolicy = {
  ...DEFAULT_RETRY_POLICY,
  retries: 1,
  retryDelayMs: 750,
};
