/**
 * The loopback allowance belongs to the CHAIN, not to the flag.
 *
 * Separate from `pinned-fetch.test.ts` because these tests MOCK the transport
 * — the property under test is which permission the adapter derives for a hop
 * it never gets to dial. Proving "a public target redirecting to loopback is
 * refused even with the opt-in set" against the real transport would need a
 * real public host in the chain, which a unit test does not get to have. The
 * real-transport file proves the socket-level halves; this one proves the
 * derivation between them.
 *
 * The regression this pins: `hopAllowsLoopback` was derived from
 * `options.allowLoopback` alone, so with the opt-in set, `https://evil.example`
 * could answer `302 Location: http://127.0.0.1:11434/…` and have the hop
 * dialled — attacker-chosen path, plaintext, on the user's own machine. The
 * SDK's own contract on `isLoopbackOAuthUrl` says a public/remote server must
 * never be allowed to steer a client at its own loopback.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ executeOAuthProxy: vi.fn() }));

vi.mock("@mcpjam/sdk/oauth/node", async () => {
  const actual = await vi.importActual<
    typeof import("@mcpjam/sdk/oauth/node")
  >("@mcpjam/sdk/oauth/node");
  return { ...actual, executeOAuthProxy: transport.executeOAuthProxy };
});

const { createPinnedFetch } = await import("../pinned-fetch.js");
const { BlockedEgressTargetError } = await import("../hosted-egress-guard.js");

function respond(status: number, headers: Record<string, string> = {}) {
  return {
    status,
    statusText: "",
    headers,
    body: "",
    finalUrl: "",
  };
}

beforeEach(() => {
  transport.executeOAuthProxy.mockReset();
});

describe("a chain that started public may not arrive at loopback", () => {
  it("refuses a public → loopback redirect even with the opt-in set", async () => {
    transport.executeOAuthProxy.mockResolvedValueOnce(
      respond(302, { location: "http://127.0.0.1:11434/steal" })
    );

    await expect(
      createPinnedFetch({ allowLoopback: true, timeoutMs: 2_000 })(
        "https://public.example/mcp"
      )
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);

    // The loopback hop was refused BEFORE the transport was asked to dial it.
    expect(transport.executeOAuthProxy).toHaveBeenCalledTimes(1);
  });

  it("keeps every hop of a public chain httpsOnly, opt-in or not", async () => {
    transport.executeOAuthProxy.mockResolvedValueOnce(respond(200));

    await createPinnedFetch({ allowLoopback: true, timeoutMs: 2_000 })(
      "https://public.example/mcp"
    );

    expect(transport.executeOAuthProxy).toHaveBeenCalledWith(
      expect.objectContaining({ httpsOnly: true })
    );
  });
});

describe("a chain that started loopback keeps its allowance", () => {
  it("follows a loopback → loopback redirect across ports", async () => {
    // A local authorization server bouncing between ports is normal local
    // development, and the chain rule must not break it.
    transport.executeOAuthProxy
      .mockResolvedValueOnce(
        respond(302, { location: "http://127.0.0.1:6060/authorize" })
      )
      .mockResolvedValueOnce(respond(200));

    const res = await createPinnedFetch({
      allowLoopback: true,
      timeoutMs: 2_000,
    })("http://127.0.0.1:3000/mcp");

    expect(res.status).toBe(200);
    expect(transport.executeOAuthProxy).toHaveBeenCalledTimes(2);
    for (const call of transport.executeOAuthProxy.mock.calls) {
      expect(call[0]).toMatchObject({ httpsOnly: false });
    }
  });
});

describe("the caller's signal reaches every hop", () => {
  it("hands the transport the signal it was given", async () => {
    transport.executeOAuthProxy
      .mockResolvedValueOnce(
        respond(302, { location: "https://public.example/next" })
      )
      .mockResolvedValueOnce(respond(200));
    const controller = new AbortController();

    await createPinnedFetch({ timeoutMs: 2_000 })(
      "https://public.example/mcp",
      { signal: controller.signal }
    );

    expect(transport.executeOAuthProxy).toHaveBeenCalledTimes(2);
    for (const call of transport.executeOAuthProxy.mock.calls) {
      expect(call[0]).toMatchObject({ signal: controller.signal });
    }
  });
});
