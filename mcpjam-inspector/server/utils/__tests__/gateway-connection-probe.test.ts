import { describe, expect, it, vi } from "vitest";
import { BlockedEgressTargetError } from "../hosted-egress-guard.js";
import { probeGatewayConnection } from "../gateway-connection-probe.js";

const CATALOG = ["anthropic/claude-sonnet-4.5", "openai/gpt-5.5"];

type Route = { status: number; body: unknown };

/** A gateway that answers each path from `routes`, and 404 elsewhere. */
function gateway(routes: Record<string, Route>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const route = routes[path] ?? { status: 404, body: { error: "not found" } };
    return new Response(JSON.stringify(route.body), { status: route.status });
  });
}

const LISTED: Record<string, Route> = {
  "/v1/models": {
    status: 200,
    body: { data: [{ id: "claude-sonnet-4-5" }, { id: "smart" }, { id: "text-embedding-3-small" }] },
  },
  "/v1/model/info": {
    status: 200,
    body: { data: [{ model_name: "smart", litellm_params: { model: "openai/gpt-5.5" } }] },
  },
  "/v1/chat/completions": { status: 200, body: {} },
  "/v1/messages": { status: 200, body: {} },
  "/v1/embeddings": { status: 200, body: {} },
};

describe("probeGatewayConnection", () => {
  it("lists models, tries each API and suggests mappings, labelled as the Inspector's", async () => {
    const fetch = gateway(LISTED);
    const result = await probeGatewayConnection({
      baseUrl: "https://litellm.acme.example/v1/",
      secret: "sk-test",
      fetch,
      catalogIds: CATALOG,
    });
    expect(result).toEqual({
      reachable: true,
      origin: "inspector",
      status: 200,
      apis: {
        chatCompletions: { result: "ok", status: 200 },
        responses: {
          result: "failed",
          status: 404,
          message:
            "The gateway has nothing at https://litellm.acme.example/v1/responses. Check the base URL and the APIs this connection serves.",
        },
        anthropicMessages: { result: "ok", status: 200 },
        embeddings: { result: "ok", status: 200 },
      },
      models: [
        { nativeModelId: "claude-sonnet-4-5", suggestedModelId: "anthropic/claude-sonnet-4.5", suggestionSource: "name" },
        { nativeModelId: "smart", suggestedModelId: "openai/gpt-5.5", suggestionSource: "gateway" },
        { nativeModelId: "text-embedding-3-small" },
      ],
    });
    // Never follows a redirect: the request carries the admin's key.
    for (const [, init] of fetch.mock.calls) expect(init?.redirect).toBe("manual");
    const messages = fetch.mock.calls.find(([url]) => String(url).endsWith("/v1/messages"));
    expect(messages?.[1]?.headers).toMatchObject({ "x-api-key": "sk-test" });
  });

  it("quotes the gateway's 401, cut short", async () => {
    const result = await probeGatewayConnection({
      baseUrl: "https://litellm.acme.example",
      secret: "sk-wrong",
      fetch: gateway({ "/v1/models": { status: 401, body: { error: { message: `Invalid key ${"x".repeat(400)}` } } } }),
      catalogIds: CATALOG,
    });
    expect(result).toMatchObject({ reachable: true, status: 401, models: [] });
    expect(result.message).toMatch(/^The gateway rejected the API key: "Invalid key x+…"\. Check the key and test again\.$/);
    expect(result.message!.length).toBeLessThan(400);
  });

  it("reports a refused address without naming what it resolved to", async () => {
    const result = await probeGatewayConnection({
      baseUrl: "https://internal.acme.example",
      fetch: vi.fn(async () => {
        throw new BlockedEgressTargetError("resolves to a private address", {
          cause: new Error("resolved address: 10.0.0.8"),
        });
      }),
      catalogIds: CATALOG,
    });
    expect(result.reachable).toBe(false);
    expect(result.refusal?.code).toBe("egress_refused");
    expect(result.message).toContain("internal.acme.example");
    expect(result.message).not.toContain("10.0.0.8");
  });

  it("reports an unreachable gateway with the host only", async () => {
    const result = await probeGatewayConnection({
      baseUrl: "https://down.acme.example",
      fetch: vi.fn(async () => {
        throw new TypeError("connect ECONNREFUSED 203.0.113.9:443");
      }),
      catalogIds: CATALOG,
    });
    expect(result).toMatchObject({ reachable: false, origin: "inspector" });
    expect(result.message).toBe(
      "This Inspector couldn't connect to down.acme.example. Check the base URL and that the gateway is running.",
    );
  });
});
