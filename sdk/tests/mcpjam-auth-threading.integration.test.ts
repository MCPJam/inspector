/**
 * A refreshed MCPJam credential threaded end to end: `HostRunner` →
 * `createModelFromString` → a lease scope bound to one auth context → the
 * real Anthropic provider → the lease proxy.
 *
 * Only `fetch` is stubbed. What is asserted is what left the process: the
 * bearer and the platform headers reach MCPJam's lease API and nothing else,
 * every iteration clone mints through the same bound scope, and the old
 * fixed-key path is untouched.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostRunner } from "../src/HostRunner.js";
import {
  McpjamModelLeaseScope,
  releaseMcpjamModelLeases,
} from "../src/mcpjam-model-lease.js";

const PROXY_BASE = "https://proxy.example.com/web/harness/model-proxy/anthropic";

type Sent = { url: string; headers: Record<string, string>; body: string };

function stubPlatform(): Sent[] {
  const sent: Sent[] = [];
  let mints = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      sent.push({ url, headers, body: String(init?.body ?? "") });
      if (url.endsWith("/model-leases")) {
        mints += 1;
        return Response.json({
          lease: `lease_${mints}`,
          protocol: "anthropic",
          proxyBaseUrl: PROXY_BASE,
          expiresAt: Date.now() + 30 * 60_000,
          runId: `run_${mints}`,
        });
      }
      if (url.endsWith("/model-leases/revoke")) {
        return Response.json({ ok: true, revoked: 1 });
      }
      if (url.startsWith(PROXY_BASE)) {
        return Response.json({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "anthropic/claude-sonnet-4.5",
          content: [{ type: "text", text: "hello from the proxy" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 4 },
        });
      }
      return new Response("unexpected", { status: 500 });
    })
  );
  return sent;
}

afterEach(async () => {
  await releaseMcpjamModelLeases();
  vi.unstubAllGlobals();
});

describe("MCPJam auth threaded through the runner", () => {
  it("mints with the refreshed bearer, shares the lease across clones, keeps secrets off the proxy", async () => {
    const sent = stubPlatform();
    let reads = 0;
    const getAuth = vi.fn(async () => `tok_${++reads}`);
    const auth = {
      getAuth,
      headers: { "x-mcpjam-client": "test-suite" },
    };
    const scope = new McpjamModelLeaseScope({ auth });
    const runner = new HostRunner({
      tools: {},
      model: "mcpjam/anthropic/claude-sonnet-4.5",
      apiKey: "",
      mcpjamAuth: auth,
      mcpjamLeaseScope: scope,
      mcpjamProject: "p_local",
      baseUrls: { mcpjam: "https://platform.example.com" },
    });

    const first = await runner.run("hi");
    // An EvalTest iteration clone: same auth context, same scope, same lease.
    const second = await runner.withOptions({}).run("again");

    expect(first.getError()).toBeUndefined();
    expect(first.text).toBe("hello from the proxy");
    expect(second.getError()).toBeUndefined();

    const mints = sent.filter((entry) => entry.url.endsWith("/model-leases"));
    expect(mints).toHaveLength(1);
    expect(mints[0]!.url).toBe(
      "https://platform.example.com/api/v1/projects/p_local/model-leases"
    );
    expect(mints[0]!.headers.authorization).toBe("Bearer tok_1");
    expect(mints[0]!.headers["x-mcpjam-client"]).toBe("test-suite");

    const proxied = sent.filter((entry) => entry.url.startsWith(PROXY_BASE));
    expect(proxied).toHaveLength(2);
    for (const request of proxied) {
      expect(request.headers["x-mcpjam-harness-lease"]).toBe("lease_1");
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers["x-api-key"]).toBeUndefined();
      expect(request.headers["x-mcpjam-client"]).toBeUndefined();
      expect(JSON.stringify(request)).not.toMatch(/tok_\d/);
      // The canonical id reaches the proxy's allowlist unchanged.
      expect(JSON.parse(request.body).model).toBe(
        "anthropic/claude-sonnet-4.5"
      );
    }

    await scope.release();
    const revokes = sent.filter((entry) =>
      entry.url.endsWith("/model-leases/revoke")
    );
    expect(revokes).toHaveLength(1);
    // Re-read for the revoke, not the token captured at mint time.
    expect(revokes[0]!.headers.authorization).toBe("Bearer tok_2");
    expect(getAuth).toHaveBeenCalledTimes(2);
  });

  it("refuses a key and an auth callback together, before any request", async () => {
    const sent = stubPlatform();
    const runner = new HostRunner({
      tools: {},
      model: "mcpjam/anthropic/claude-sonnet-4.5",
      apiKey: "sk_fixed_key",
      mcpjamAuth: { getAuth: async () => "tok" },
    });
    const result = await runner.run("hi");
    expect(result.getError()).toMatch(/supply exactly one/);
    expect(sent).toHaveLength(0);
  });

  it("leaves the fixed-key path as it was", async () => {
    const sent = stubPlatform();
    const runner = new HostRunner({
      tools: {},
      model: "mcpjam/anthropic/claude-sonnet-4.5",
      apiKey: "sk_fixed_key",
      baseUrls: { mcpjam: "https://platform.example.com" },
    });
    const result = await runner.run("hi");
    expect(result.getError()).toBeUndefined();
    const mint = sent.find((entry) => entry.url.endsWith("/model-leases"));
    expect(mint?.headers.authorization).toBe("Bearer sk_fixed_key");
    // `default` sentinel project, as before.
    expect(mint?.url).toBe(
      "https://platform.example.com/api/v1/projects/default/model-leases"
    );
  });
});
