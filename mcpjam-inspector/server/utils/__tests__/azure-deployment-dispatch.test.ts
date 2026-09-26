import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  azureModelIds: [] as string[],
  freeChatCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn(() => (modelId: string) => {
    mocks.azureModelIds.push(modelId);
    return { modelId };
  }),
}));

vi.mock("../mcpjam-stream-handler.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../mcpjam-stream-handler.js")>()),
  handleMCPJamFreeChatModel: vi.fn(async (options: Record<string, unknown>) => {
    mocks.freeChatCalls.push(options);
    return new Response("ok");
  }),
}));

import { createLlmModel } from "../chat-helpers.js";
import { handleHostedOrgChatModel } from "../org-model-stream-handler.js";

describe("Azure deployment dispatch", () => {
  beforeEach(() => {
    mocks.azureModelIds.length = 0;
    mocks.freeChatCalls.length = 0;
    process.env.CONVEX_HTTP_URL = "https://backend.test";
  });

  it("createLlmModel runs an org deployment row on its explicit deployment", () => {
    createLlmModel(
      {
        id: "azure/prod-gpt51",
        name: "prod-gpt51 (Azure)",
        provider: "azure",
        nativeModelId: "prod-gpt51",
      },
      "sk-fixture-placeholder",
      { azure: "https://contoso.openai.azure.com/openai" },
    );
    expect(mocks.azureModelIds).toEqual(["prod-gpt51"]);
  });

  it("createLlmModel keeps the row id when no deployment is named", () => {
    createLlmModel(
      { id: "azure/gpt-5.1", name: "GPT-5.1 (Azure)", provider: "azure" },
      "sk-fixture-placeholder",
      { azure: "https://contoso.openai.azure.com/openai" },
    );
    // Unchanged legacy behavior: nothing is stripped.
    expect(mocks.azureModelIds).toEqual(["azure/gpt-5.1"]);
  });

  it("handleHostedOrgChatModel sends nativeModelId to /stream/org", async () => {
    const base = {
      projectId: "proj_1",
      providerKey: "azure",
      modelId: "azure/prod-gpt51",
      messages: [],
      systemPrompt: "",
      tools: {},
    } as unknown as Parameters<typeof handleHostedOrgChatModel>[0];
    await handleHostedOrgChatModel({ ...base, nativeModelId: " prod-gpt51 " });
    await handleHostedOrgChatModel(base);
    expect(mocks.freeChatCalls[0]).toMatchObject({
      endpointPath: "/stream/org",
      modelId: "azure/prod-gpt51",
      extraBodyFields: { providerKey: "azure", nativeModelId: "prod-gpt51" },
    });
    expect(mocks.freeChatCalls[1].extraBodyFields).toEqual({
      providerKey: "azure",
    });
  });
});
