/**
 * The pinned transport adapter, and the one property that makes it safe to use.
 *
 * `server-connection-discovery` decides `terminal` vs `retryable` by
 * `instanceof BlockedEgressTargetError`. An earlier revision of this adapter
 * flattened every `OAuthProxyError` into a plain `Error`, which erased that
 * distinction: an SSRF refusal became indistinguishable from a timeout, so a
 * target we had already refused went straight back onto a retry schedule.
 *
 * THESE TESTS DRIVE THE REAL TRANSPORT. The adapter tells a refusal from a
 * failure by matching the SDK's message, because `OAuthProxyError` carries only
 * a `status` — 400 for both "resolves to a private or reserved address" and
 * "request timeout", which are opposite verdicts. Matching prose across a
 * package boundary is only safe if something notices when the prose changes,
 * and that is what these are: they call `createPinnedFetch` at real reserved
 * addresses and assert the class that comes back, so a reworded SDK message
 * fails here instead of silently downgrading a refusal.
 */

import { describe, expect, it } from "vitest";
import { createPinnedFetch } from "../pinned-fetch.js";
import {
  BlockedEgressTargetError,
  EgressResolutionError,
} from "../hosted-egress-guard.js";

const pinnedFetch = createPinnedFetch({ timeoutMs: 2_000 });

describe("refusals keep their class", () => {
  it("refuses a literal loopback address as a blocked target", async () => {
    await expect(pinnedFetch("http://127.0.0.1:9/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses the cloud metadata address", async () => {
    // The address this whole guard exists for.
    await expect(
      pinnedFetch("http://169.254.169.254/latest/meta-data/")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("refuses a private RFC 1918 address", async () => {
    await expect(pinnedFetch("http://10.0.0.1/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses IPv6 loopback", async () => {
    await expect(pinnedFetch("http://[::1]:9/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses a non-http scheme", async () => {
    await expect(pinnedFetch("file:///etc/passwd")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });

  it("refuses a URL that carries credentials", async () => {
    await expect(
      pinnedFetch("https://user:pass@example.com/mcp")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("refuses a malformed URL", async () => {
    await expect(pinnedFetch("not-a-url")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });
});

describe("the loopback opt-in is real in both directions", () => {
  // These two are the regression pair for a bug that looked like a nit and was
  // not: `allowLoopback` was declared on the options, documented as a local-dev
  // carve-out, and forwarded to nothing — `OAuthProxyRequest` has no such
  // field. The default therefore permitted `http://127.0.0.1:…` in production
  // (the SDK infers loopback permission from the URL whenever `httpsOnly` is
  // false), while opting in changed nothing at all.

  it("refuses loopback by default", async () => {
    await expect(
      createPinnedFetch({ timeoutMs: 2_000 })("http://127.0.0.1:9/mcp")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);
  });

  it("dials loopback when the caller opted in", async () => {
    // Port 9 (discard) is closed here, so reaching the socket layer at all is
    // the proof: a connection error means the guard let it through, where a
    // `BlockedEgressTargetError` would mean local development is broken.
    const error = await createPinnedFetch({
      allowLoopback: true,
      timeoutMs: 2_000,
    })("http://127.0.0.1:9/mcp").catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(BlockedEgressTargetError);
    expect(error).toBeInstanceOf(Error);
  });

  it("still refuses non-loopback private addresses even with the opt-in", async () => {
    // The carve-out is for loopback ONLY. It never relaxes the guard for LAN,
    // link-local, CGNAT, multicast, documentation, or NAT64-private targets.
    const pinned = createPinnedFetch({ allowLoopback: true, timeoutMs: 2_000 });

    await expect(pinned("http://169.254.169.254/")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
    await expect(pinned("http://10.0.0.1/mcp")).rejects.toBeInstanceOf(
      BlockedEgressTargetError
    );
  });
});

describe("outages stay retryable", () => {
  it("reports an unresolvable host as a resolution failure, not a verdict", async () => {
    // `.invalid` is reserved by RFC 2606 and cannot resolve. A DNS answer we
    // could not get is our problem to retry; calling it "blocked" would tell a
    // user their server is forbidden because our resolver hiccuped.
    const error = await pinnedFetch(
      "https://mcpjam-nonexistent.invalid/mcp"
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EgressResolutionError);
    expect(error).not.toBeInstanceOf(BlockedEgressTargetError);
  });
});
