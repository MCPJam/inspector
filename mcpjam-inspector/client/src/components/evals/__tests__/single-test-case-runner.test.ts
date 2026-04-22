import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTestCaseModelOptions,
  getDefaultTestCaseModelValue,
  getPersistedTestCaseModelValue,
  prepareSingleTestCaseRun,
  resolveSelectedTestCaseModelValue,
  setPersistedTestCaseModelValue,
} from "../single-test-case-runner";

describe("single-test-case-runner", () => {
  const suite = {
    environment: {
      servers: ["asana"],
    },
  };

  const testCase = {
    _id: "case-1",
    models: [{ provider: "openai", model: "gpt-4o" }],
  };

  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns the first configured case model", () => {
    expect(getDefaultTestCaseModelValue(testCase)).toBe("openai/gpt-4o");
  });

  it("builds model options from all available models", () => {
    const modelOptions = buildTestCaseModelOptions(
      [
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          provider: "anthropic",
        },
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 Mini",
          provider: "openai",
        },
      ],
      testCase,
    );

    expect(modelOptions.map((option) => option.label)).toEqual([
      "Claude Haiku 4.5",
      "GPT-5 Mini",
      "gpt-4o",
    ]);
  });

  it("prefers the persisted model selection when it is available", () => {
    const modelOptions = buildTestCaseModelOptions(
      [
        {
          id: "anthropic/claude-haiku-4.5",
          name: "Claude Haiku 4.5",
          provider: "anthropic",
        },
        {
          id: "openai/gpt-5-mini",
          name: "GPT-5 Mini",
          provider: "openai",
        },
      ],
      testCase,
    );

    setPersistedTestCaseModelValue(
      "case-1",
      "anthropic/anthropic/claude-haiku-4.5",
    );

    expect(getPersistedTestCaseModelValue("case-1")).toBe(
      "anthropic/anthropic/claude-haiku-4.5",
    );
    expect(
      resolveSelectedTestCaseModelValue({
        testCaseId: "case-1",
        testCase,
        modelOptions,
      }),
    ).toBe("anthropic/anthropic/claude-haiku-4.5");
  });

  it("prepares a one-off case run request", async () => {
    const prepared = await prepareSingleTestCaseRun({
      workspaceId: "workspace-1",
      suite,
      testCase,
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      getToken: vi.fn().mockReturnValue("openai-key"),
      hasToken: vi.fn().mockReturnValue(true),
    });

    expect(prepared).toEqual({
      modelValue: "openai/gpt-4o",
      request: {
        workspaceId: "workspace-1",
        testCaseId: "case-1",
        model: "gpt-4o",
        provider: "openai",
        serverIds: ["asana"],
        modelApiKeys: {
          openai: "openai-key",
        },
        convexAuthToken: "token-123",
        testCaseOverrides: undefined,
      },
    });
  });

  it("uses the explicitly selected model when provided", async () => {
    const prepared = await prepareSingleTestCaseRun({
      workspaceId: "workspace-1",
      suite,
      testCase,
      selectedModel: "anthropic/anthropic/claude-haiku-4.5",
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      getToken: vi.fn().mockReturnValue(null),
      hasToken: vi.fn().mockReturnValue(false),
    });

    expect(prepared).toEqual({
      modelValue: "anthropic/anthropic/claude-haiku-4.5",
      request: {
        workspaceId: "workspace-1",
        testCaseId: "case-1",
        model: "anthropic/claude-haiku-4.5",
        provider: "anthropic",
        serverIds: ["asana"],
        modelApiKeys: undefined,
        convexAuthToken: "token-123",
        testCaseOverrides: undefined,
      },
    });
  });

  it("does not require a user API key for MCPJam-provided models stored without the provider prefix", async () => {
    const prepared = await prepareSingleTestCaseRun({
      workspaceId: "workspace-1",
      suite,
      testCase: {
        _id: "case-1",
        models: [{ provider: "anthropic", model: "claude-haiku-4.5" }],
      },
      getAccessToken: vi.fn().mockResolvedValue("token-123"),
      getToken: vi.fn().mockReturnValue(null),
      hasToken: vi.fn().mockReturnValue(false),
    });

    expect(prepared).toEqual({
      modelValue: "anthropic/claude-haiku-4.5",
      request: {
        workspaceId: "workspace-1",
        testCaseId: "case-1",
        model: "claude-haiku-4.5",
        provider: "anthropic",
        serverIds: ["asana"],
        modelApiKeys: undefined,
        convexAuthToken: "token-123",
        testCaseOverrides: undefined,
      },
    });
  });

  it("throws when a case has no configured model", async () => {
    await expect(
      prepareSingleTestCaseRun({
        workspaceId: "workspace-1",
        suite,
        testCase: {
          _id: "case-1",
          models: [],
        },
        getAccessToken: vi.fn().mockResolvedValue("token-123"),
        getToken: vi.fn().mockReturnValue("openai-key"),
        hasToken: vi.fn().mockReturnValue(true),
      }),
    ).rejects.toThrow("Add a model first");
  });
});
