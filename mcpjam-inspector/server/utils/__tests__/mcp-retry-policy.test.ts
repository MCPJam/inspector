import { describe, expect, it } from "vitest";

import { INSPECTOR_MCP_RETRY_POLICY } from "../mcp-retry-policy.js";

describe("INSPECTOR_MCP_RETRY_POLICY", () => {
  it("retries transient connect failures at least once", () => {
    // Regression guard: the SDK default is 0 retries, which turned every
    // stale keep-alive reset into a user-facing 502 on hosted connects. The
    // manager applies this policy to connectToServer with
    // isRetryableTransientError gating, so >=1 here is what absorbs those.
    expect(INSPECTOR_MCP_RETRY_POLICY.retries).toBeGreaterThanOrEqual(1);
  });

  it("keeps the retry delay interactive", () => {
    // These connects run behind a user-visible spinner; a retry that waits
    // multiple seconds reads as a hang.
    expect(INSPECTOR_MCP_RETRY_POLICY.retryDelayMs).toBeLessThanOrEqual(1000);
  });

  it("bounds the worst-case added latency", () => {
    // A tuning change can adjust either knob, but the total delay a failing
    // connect can add before surfacing must stay interactive.
    expect(
      INSPECTOR_MCP_RETRY_POLICY.retries *
        INSPECTOR_MCP_RETRY_POLICY.retryDelayMs,
    ).toBeLessThanOrEqual(2000);
  });
});
