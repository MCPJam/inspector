/**
 * The streaming transport's INSPECTOR-side contract: hosted gating, and the
 * error taxonomy that decides `terminal` vs `retryable`.
 *
 * The transport's own behavior (pin the address, re-check every hop, cap the
 * body) is proven against real sockets in the SDK. What can only be proven
 * here is the wrapping: a refusal must arrive as `BlockedEgressTargetError`,
 * because `server-connection-discovery` classifies on `instanceof` and a
 * flattened class puts a refused target back on a retry schedule — the exact
 * outcome its bookkeeping exists to prevent.
 */

import { describe, expect, it } from "vitest";

import { createStreamingPinnedFetch } from "../pinned-fetch.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../hosted-egress-guard.js";

describe("createStreamingPinnedFetch", () => {
  it("is the untouched global fetch outside hosted mode", async () => {
    // Locally, reaching localhost is the entire product; the guard is an
    // egress decision that only exists on our nodes.
    const local = createStreamingPinnedFetch({ hosted: false });
    await expect(local("http://127.0.0.1:1/nothing")).rejects.not.toBeInstanceOf(
      BlockedEgressTargetError,
    );
  });

  it("refuses a literal link-local target as a blocked egress target", async () => {
    const guarded = createStreamingPinnedFetch({ hosted: true });
    await expect(
      guarded("https://169.254.169.254/latest/meta-data/"),
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("refuses loopback in hosted mode without the opt-in", async () => {
    const guarded = createStreamingPinnedFetch({ hosted: true });
    await expect(guarded("http://127.0.0.1:9/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError,
    );
  });

  it("never repeats the address a hostname resolved to", async () => {
    const guarded = createStreamingPinnedFetch({ hosted: true });
    // Naming the resolved answer would turn a refusal into a resolution
    // oracle: submit a name, read back what our resolver saw, repeat.
    await expect(guarded("https://169.254.169.254/")).rejects.toThrow(
      /not a publicly routable address/,
    );
  });

  it("classifies an unresolvable host as a resolution failure, not a refusal", async () => {
    const guarded = createStreamingPinnedFetch({ hosted: true });
    await expect(
      guarded("https://this-host-does-not-exist.invalid/mcp"),
    ).rejects.toBeInstanceOf(EgressResolutionError);
  });
});
