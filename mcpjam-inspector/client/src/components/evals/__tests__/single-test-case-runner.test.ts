import { describe, expect, it, vi } from "vitest";
import {
  getDefaultTestCaseModelValue,
  prepareSingleTestCaseRun,
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

  it("returns the first configured case model", () => {
    expect(getDefaultTestCaseModelValue(testCase)).toBe("openai/gpt-4o");
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
