/**
 * A custom provider's base URL is an organization admin's setting, promoted
 * into the runtime config by `buildLlmRuntimeConfigFromOrgConfig`. Hosted,
 * this process dials it from a shared network, so every request to it, each
 * redirect hop included, passes the hosted egress guard: a private address
 * only when MCPJAM_PRIVATE_EGRESS_ALLOWLIST lists it, cloud metadata never.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";

vi.mock("../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config.js")>()),
  HOSTED_MODE: true,
}));

import { createLlmModel } from "../chat-helpers.js";
import {
  BlockedEgressTargetError,
  setEgressHostResolverForTests,
} from "../hosted-egress-guard.js";
import { buildLlmRuntimeConfigFromOrgConfig } from "../org-model-config.js";

const COMPLETION = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 0,
  model: "gpt-x",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function gatewayModel(
  baseUrl: string,
  protocol: "openai-compatible" | "anthropic-compatible" = "openai-compatible",
) {
  const runtime = buildLlmRuntimeConfigFromOrgConfig({
    providers: [
      {
        providerKey: "custom:gateway",
        baseUrl,
        protocol,
        modelIds: ["gpt-x"],
        apiKey: "sk-test",
      },
    ],
  });
  return createLlmModel(
    {
      id: "custom:gateway:gpt-x",
      name: "gpt-x",
      provider: "custom",
      customProviderName: "gateway",
    },
    "",
    runtime.baseUrls,
    runtime.customProviders,
  );
}

beforeEach(() => {
  setEgressHostResolverForTests(async (hostname) =>
    hostname === "gateway.example.test" ? ["93.184.216.34"] : [],
  );
});

afterEach(() => {
  setEgressHostResolverForTests(null);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a hosted custom provider base URL", () => {
  it.each(["openai-compatible", "anthropic-compatible"] as const)(
    "is refused before anything is sent when it is private (%s)",
    async (protocol) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const error = await generateText({
        model: gatewayModel("http://10.0.0.5/v1", protocol),
        prompt: "hi",
        maxRetries: 0,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BlockedEgressTargetError);
      expect((error as Error).message).toContain(
        'Custom provider "gateway" URL points at a private or internal address',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("is re-checked on a redirect, which cannot reach cloud metadata", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const error = await generateText({
      model: gatewayModel("https://gateway.example.test/v1"),
      prompt: "hi",
      maxRetries: 0,
    }).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(BlockedEgressTargetError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://gateway.example.test/v1/chat/completions",
    );
  });

  it("reaches a private gateway the operator listed", async () => {
    vi.stubEnv("MCPJAM_PRIVATE_EGRESS_ALLOWLIST", "10.0.0.0/8");
    const fetchMock = vi.fn(async () => Response.json(COMPLETION));
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateText({
      model: gatewayModel("http://10.0.0.5/v1"),
      prompt: "hi",
      maxRetries: 0,
    });
    expect(result.text).toBe("ok");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://10.0.0.5/v1/chat/completions",
    );
  });
});

describe("other admin-typed base URLs, hosted", () => {
  it.each([
    ["ollama", { ollama: "http://10.0.0.7:11434" }, "Ollama URL"],
    ["azure", { azure: "http://10.0.0.8/openai" }, "Azure OpenAI URL"],
    ["bedrock", { bedrock: "http://10.0.0.9" }, "Amazon Bedrock URL"],
  ] as const)(
    "%s is refused before anything is sent when it is private",
    async (provider, baseUrls, label) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const error = await generateText({
        model: createLlmModel(
          { id: "m", name: "m", provider },
          "sk-test",
          baseUrls,
        ),
        prompt: "hi",
        maxRetries: 0,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BlockedEgressTargetError);
      expect((error as Error).message).toContain(label);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
