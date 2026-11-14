import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hosted: false }));
const buildModel = vi.hoisted(() => vi.fn(() => ({ modelId: "llama3" })));
const policy = vi.hoisted(() => vi.fn());
const wrap = vi.hoisted(() => vi.fn((model) => model));
vi.mock("../../../config.js", () => ({
  get HOSTED_MODE() {
    return state.hosted;
  },
}));
vi.mock("../../../utils/chat-helpers.js", () => ({
  createLlmModel: buildModel,
}));
vi.mock("../../../utils/own-key-turn-policy.js", () => ({
  ownKeyTurnCheck: policy,
  withOwnKeyTurnPolicy: wrap,
}));

import { prepareDirectProvider } from "../direct-provider.js";

const input = () => ({
  input: { baseUrls: { ollama: "http://127.0.0.1:11434" } },
  model: { id: "llama3", name: "Llama", provider: "ollama" },
  auth: {},
});

beforeEach(() => {
  state.hosted = false;
  vi.clearAllMocks();
  policy.mockResolvedValue({ refusal: undefined, readAt: 123 });
});
afterEach(() => vi.unstubAllEnvs());

describe("local direct-provider setup", () => {
  it("preserves no-backend local execution and the selected endpoint", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "");
    const prepared = await prepareDirectProvider(input());
    expect(buildModel).toHaveBeenCalledWith(
      input().model,
      "",
      input().input.baseUrls,
      undefined,
    );
    expect(prepared.model).toEqual({ modelId: "llama3" });
    expect(wrap).toHaveBeenCalledWith(
      prepared.model,
      expect.objectContaining({ projectId: undefined }),
      { allowedAt: 123 },
    );
  });

  it("refuses a managed policy failure before constructing the provider", async () => {
    const refusal = new Error("policy unavailable");
    policy.mockResolvedValue({ refusal });
    await expect(
      prepareDirectProvider({ ...input(), projectId: "managed" }),
    ).rejects.toBe(refusal);
    expect(buildModel).not.toHaveBeenCalled();
  });

  it("never grants direct local execution to a hosted service", async () => {
    state.hosted = true;
    await expect(prepareDirectProvider(input())).rejects.toMatchObject({
      status: 403,
    });
    expect(policy).not.toHaveBeenCalled();
    expect(buildModel).not.toHaveBeenCalled();
  });

  it("preserves the personal cloud-key refusal on configured backends", async () => {
    vi.stubEnv("CONVEX_HTTP_URL", "https://configured.example.test");
    await expect(
      prepareDirectProvider({
        ...input(),
        input: { apiKey: "test-key" },
        model: { id: "gpt-5", name: "GPT", provider: "openai" },
      }),
    ).rejects.toMatchObject({
      status: 401,
      details: { code: "personal_byok_unsupported" },
    });
    expect(buildModel).not.toHaveBeenCalled();
  });
});
