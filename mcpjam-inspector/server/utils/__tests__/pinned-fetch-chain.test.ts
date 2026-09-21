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

function respond(
  status: number,
  headers: Record<string, string> = {},
  targetIsPrivate = false,
) {
  return {
    status,
    statusText: "",
    headers,
    body: "",
    finalUrl: "",
    // Where the transport says the hop LANDED. The adapter fixes the chain's
    // character from this rather than from the hostname, so the mock has to
    // answer it for the derivation under test to mean anything.
    targetIsPrivate,
  };
}

beforeEach(() => {
  transport.executeOAuthProxy.mockReset();
});

describe("a chain that started public may not arrive at loopback", () => {
  it("refuses a public → loopback redirect even with the opt-in set", async () => {
    transport.executeOAuthProxy.mockResolvedValueOnce(
      respond(302, { location: "http://127.0.0.1:11434/steal" }, false)
    );

    await expect(
      createPinnedFetch({
        allowLoopback: true,
        allowPrivateNetwork: false,
        timeoutMs: 2_000,
      })("https://public.example/mcp")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);

    // The loopback hop was refused BEFORE the transport was asked to dial it.
    expect(transport.executeOAuthProxy).toHaveBeenCalledTimes(1);
  });

  it("narrows a chain to httpsOnly once the first hop lands public", async () => {
    // Hop 0 carries the caller's permission, because nothing here can tell a
    // public hostname from one that answers loopback. The transport reports
    // that it landed public, and every hop after it is held to the strict
    // policy — which is what keeps a public chain from wandering onto the
    // caller's own network two hops later.
    transport.executeOAuthProxy
      .mockResolvedValueOnce(
        respond(302, { location: "https://public.example/next" }, false)
      )
      .mockResolvedValueOnce(respond(200, {}, false));

    await createPinnedFetch({ allowLoopback: true, timeoutMs: 2_000 })(
      "https://public.example/mcp"
    );

    const calls = transport.executeOAuthProxy.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toMatchObject({ allowPrivateNetwork: true });
    expect(calls[1][0]).toMatchObject({
      httpsOnly: true,
      allowPrivateNetwork: false,
    });
  });

  it("refuses a public-landing chain that then redirects to a private host", async () => {
    // The same rule seen from the attack: a public server answering
    // `302 Location: http://10.0.0.1/…` cannot make the local inspector
    // fetch it, because hop 0 reported that it landed public.
    transport.executeOAuthProxy.mockResolvedValueOnce(
      respond(302, { location: "http://10.0.0.1/steal" }, false)
    );

    await expect(
      createPinnedFetch({ timeoutMs: 2_000 })("https://public.example/mcp")
    ).rejects.toBeInstanceOf(BlockedEgressTargetError);

    expect(transport.executeOAuthProxy).toHaveBeenCalledTimes(1);
  });

  it("keeps the allowance for a chain whose first hop landed private", async () => {
    // The counterpart, and the case a hostname test refuses by mistake: the
    // start URL reads as public and answers loopback, so hop 0 reports
    // private and the redirect to another private port is followed.
    transport.executeOAuthProxy
      .mockResolvedValueOnce(
        respond(302, { location: "http://auth.localtest.me:9401/token" }, true)
      )
      .mockResolvedValueOnce(respond(200, {}, true));

    const res = await createPinnedFetch({ timeoutMs: 2_000 })(
      "http://auth.localtest.me:9400/token"
    );

    expect(res.status).toBe(200);
    const calls = transport.executeOAuthProxy.mock.calls;
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call[0]).toMatchObject({ allowPrivateNetwork: true });
    }
  });
});

describe("a chain that started loopback keeps its allowance", () => {
  it("follows a loopback → loopback redirect across ports", async () => {
    // A local authorization server bouncing between ports is normal local
    // development, and the chain rule must not break it.
    transport.executeOAuthProxy
      .mockResolvedValueOnce(
        respond(302, { location: "http://127.0.0.1:6060/authorize" }, true)
      )
      .mockResolvedValueOnce(respond(200, {}, true));

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
