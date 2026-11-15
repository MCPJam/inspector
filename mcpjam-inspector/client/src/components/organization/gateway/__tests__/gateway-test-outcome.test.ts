import { describe, expect, it } from "vitest";
import type { GatewayConnectionTestResult } from "@/shared/gateway-connection";
import {
  apisFromTest,
  baseUrlKeyProblem,
  gatewayTestOutcome,
  inspectorTestKeyOutcome,
  modelsFromTest,
  suggestedGatewayName,
} from "../gateway-test-outcome";

function result(
  overrides: Partial<GatewayConnectionTestResult> = {},
): GatewayConnectionTestResult {
  return {
    reachable: true,
    origin: "backend",
    status: 200,
    apis: {
      chatCompletions: { result: "ok", status: 200 },
      responses: { result: "ok", status: 200 },
      anthropicMessages: { result: "ok", status: 200 },
      embeddings: { result: "untested" },
    },
    models: [
      { nativeModelId: "claude-sonnet-4.5", suggestedModelId: "anthropic/claude-sonnet-4.5", suggestionSource: "name" },
      { nativeModelId: "gpt-5.5", suggestedModelId: "openai/gpt-5.5", suggestionSource: "gateway" },
      { nativeModelId: "house-model" },
    ],
    ...overrides,
  };
}

describe("gatewayTestOutcome", () => {
  it("reports success with what answered, and where it was tested from", () => {
    expect(gatewayTestOutcome(result())).toEqual({
      tone: "success",
      title: "Connected",
      message: "3 models listed. Chat Completions, Responses, Anthropic Messages answered.",
      testedFrom: "Tested from MCPJam's servers",
    });
    expect(gatewayTestOutcome(result({ origin: "inspector" })).testedFrom).toBe(
      "Tested from your Inspector",
    );
  });

  it("reports a partial result as a warning naming the APIs that failed", () => {
    const outcome = gatewayTestOutcome(
      result({
        apis: {
          chatCompletions: { result: "ok", status: 200 },
          responses: { result: "failed", status: 404, message: "The gateway has nothing at https://gw.example.com/v1/responses. Check the base URL and the APIs this connection serves." },
          anthropicMessages: { result: "ok", status: 200 },
        },
      }),
    );
    expect(outcome).toMatchObject({
      tone: "warning",
      title: "Responses didn't answer",
      message: expect.stringContaining("/v1/responses"),
    });
    expect(outcome.focus).toBeUndefined();
  });

  it("quotes the gateway on a 401 and moves focus to the key", () => {
    const message = 'The gateway rejected the API key: "Authentication Error, Invalid proxy server token passed". Check the key and test again.';
    expect(gatewayTestOutcome(result({ status: 401, message, apis: {}, models: [] }))).toEqual({
      tone: "destructive",
      title: "The gateway needs a valid API key",
      message,
      focus: "secret",
      testedFrom: "Tested from MCPJam's servers",
    });
  });

  it("reports a 403 as the gateway refusing, without blaming a field", () => {
    const outcome = gatewayTestOutcome(
      result({ status: 403, message: "The gateway refused the request: \"Budget exceeded\". Check the key's budget and model access on the gateway.", apis: {}, models: [] }),
    );
    expect(outcome).toMatchObject({ tone: "destructive", title: "The gateway refused the request" });
    expect(outcome.focus).toBeUndefined();
  });

  it("shows the guard's reason and offers the Inspector when MCPJam's servers refuse a private address", () => {
    const message = `Base URL points at "10.0.0.8", a private address MCPJam's servers can't call. List it in MCPJAM_PRIVATE_EGRESS_ALLOWLIST on a self-hosted install, or set the connection to run from each user's Inspector.`;
    const refused = result({ reachable: false, status: undefined, refusal: { code: "endpoint_private", message }, message, apis: {}, models: [] });
    expect(gatewayTestOutcome(refused)).toEqual({
      tone: "destructive",
      title: "MCPJam's servers won't call this URL",
      message,
      focus: "baseUrl",
      offerInspector: true,
      testedFrom: "Tested from MCPJam's servers",
    });
    // From the Inspector there is no other side to switch to.
    expect(gatewayTestOutcome({ ...refused, origin: "inspector" }).offerInspector).toBe(false);
  });

  it("moves focus to the base URL when the gateway is unreachable", () => {
    expect(
      gatewayTestOutcome(result({ reachable: false, status: undefined, message: "MCPJam's servers couldn't connect to gw.example.com. Check the base URL and that the gateway is running.", apis: {}, models: [] })),
    ).toMatchObject({ tone: "destructive", title: "Couldn't reach the gateway. Check the base URL, then test again.", focus: "baseUrl" });
  });

  it("says when no API answered, focusing the key on a 401", () => {
    expect(
      gatewayTestOutcome(result({ apis: { chatCompletions: { result: "failed", status: 401, message: "The gateway asked for an API key. Enter the key, then test again." } } })),
    ).toMatchObject({ tone: "destructive", title: "No API answered. Check the base URL and key, then test again.", focus: "secret" });
  });

  it("reports a test that couldn't run", () => {
    expect(gatewayTestOutcome({ error: "Too many connection tests for this organization. Wait a minute, then test again." })).toEqual({
      tone: "destructive",
      title: "Could not start the gateway test. Try again.",
      message: "Too many connection tests for this organization. Wait a minute, then test again.",
    });
  });
});

describe("filling the editor from a test", () => {
  it("keeps the APIs that answered", () => {
    expect(apisFromTest(result())).toEqual(["chatCompletions", "responses", "anthropicMessages"]);
  });

  it("suggests mappings with their source and keeps an admin's mapping", () => {
    expect(
      modelsFromTest(result(), [
        { nativeModelId: "gpt-5.5", modelId: "openai/gpt-5", mappingSource: "admin" },
        { nativeModelId: "retired-model" },
      ]),
    ).toEqual([
      { nativeModelId: "claude-sonnet-4.5", modelId: "anthropic/claude-sonnet-4.5", mappingSource: "name" },
      { nativeModelId: "gpt-5.5", modelId: "openai/gpt-5", mappingSource: "admin" },
      { nativeModelId: "house-model" },
      { nativeModelId: "retired-model" },
    ]);
  });

  it("names the connection after the gateway's host", () => {
    expect(suggestedGatewayName("https://litellm.acme.internal/v1")).toBe("litellm");
    expect(suggestedGatewayName("https://api.groq.com/openai/v1")).toBe("groq");
    expect(suggestedGatewayName("http://10.0.0.8:4000")).toBe("gateway");
  });
});

describe("baseUrlKeyProblem", () => {
  const saved = { baseUrl: "https://litellm.acme.internal/v1", hasSecret: true };

  it("asks for the key again when a keyed connection's base URL changes", () => {
    expect(baseUrlKeyProblem(saved, "https://gw.other.example/v1", "")).toBe(
      "Changing the base URL needs the API key again. Enter the key for gw.other.example.",
    );
    expect(baseUrlKeyProblem(saved, "https://gw.other.example/v1", "sk-new")).toBeNull();
  });

  it("treats the same URL with or without the version as unchanged", () => {
    expect(baseUrlKeyProblem(saved, "https://litellm.acme.internal/", "")).toBeNull();
    expect(baseUrlKeyProblem({ ...saved, hasSecret: false }, "https://gw.other.example", "")).toBeNull();
    expect(baseUrlKeyProblem(null, "https://gw.other.example", "")).toBeNull();
  });
});

describe("inspectorTestKeyOutcome", () => {
  const keyed = { hasSecret: true };

  it("asks for the key before a keyed connection is tested from the Inspector", () => {
    expect(inspectorTestKeyOutcome(keyed, "local", "  ")).toMatchObject({
      title: "Your Inspector can't use the saved key",
      focus: "secret",
    });
  });

  it("lets every other test run", () => {
    expect(inspectorTestKeyOutcome(keyed, "local", "sk-lan")).toBeNull();
    expect(inspectorTestKeyOutcome(keyed, "cloud", "")).toBeNull();
    expect(
      inspectorTestKeyOutcome({ hasSecret: false }, "local", ""),
    ).toBeNull();
    expect(inspectorTestKeyOutcome(null, "local", "")).toBeNull();
  });
});
