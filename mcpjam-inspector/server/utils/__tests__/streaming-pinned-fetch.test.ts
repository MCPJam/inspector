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

import { describe, expect, it, vi } from "vitest";

/**
 * DNS is stubbed for the whole file, and that is safe: every other case here
 * dials a NUMERIC address, which the pinned transport classifies without a
 * lookup. Only the unresolvable-host case reaches the resolver.
 *
 * It is stubbed at all because a `.invalid` name is reserved but not
 * guaranteed: a wildcard or captive resolver in CI answers with a routable
 * address, the transport dials it, and the rejection arrives as a plain
 * `Error` — so the case would pass or fail on the network rather than on the
 * classification it exists to prove.
 */
vi.mock("node:dns", async () => {
  const actual = await vi.importActual<typeof import("node:dns")>("node:dns");
  return {
    ...actual,
    default: actual,
    lookup: (
      _hostname: string,
      options: unknown,
      callback?: (error: NodeJS.ErrnoException | null) => void,
    ) => {
      const done = (typeof options === "function" ? options : callback) as (
        error: NodeJS.ErrnoException | null,
      ) => void;
      const error: NodeJS.ErrnoException = new Error("getaddrinfo ENOTFOUND");
      error.code = "ENOTFOUND";
      done(error);
    },
  };
});

const { createStreamingPinnedFetch } = await import("../pinned-fetch.js");
const { BlockedEgressTargetError, EgressResolutionError } = await import(
  "../hosted-egress-guard.js"
);

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

  it("says a plaintext target is plaintext, not unroutable", async () => {
    // The address message is right for an address problem and wrong for this
    // one: an `http://` connector on a perfectly public host was being told it
    // "is not a publicly routable address", sending its owner to look at DNS
    // and firewalls for something one character in the URL fixes.
    const guarded = createStreamingPinnedFetch({ hosted: true });
    const refusal = await guarded("http://example.com/mcp").catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BlockedEgressTargetError);
    expect((refusal as Error).message).toMatch(/plaintext/i);
    expect((refusal as Error).message).toMatch(/https/i);
    expect((refusal as Error).message).not.toMatch(/publicly routable/i);
  });

  it("classifies an unresolvable host as a resolution failure, not a refusal", async () => {
    // `retryable`, not `terminal`: DNS failing is ours to retry, and reporting
    // it as an egress REFUSAL would put a perfectly legitimate target on the
    // permanently-blocked list.
    const guarded = createStreamingPinnedFetch({ hosted: true });
    await expect(
      guarded("https://this-host-does-not-exist.example/mcp"),
    ).rejects.toBeInstanceOf(EgressResolutionError);
  });
});
