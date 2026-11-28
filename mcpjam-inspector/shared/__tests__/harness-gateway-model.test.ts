import { describe, expect, it } from "vitest";
import {
  gatewayHarnessModel,
  gatewayLeaseSelection,
  gatewayModelFor,
  gatewayModelName,
  harnessOrgUpstreamProfile,
  type HarnessGatewayModel,
} from "../harness-gateway-model";

const MESSAGES: HarnessGatewayModel = {
  providerKey: "custom:litellm",
  apis: ["chatCompletions", "anthropicMessages"],
  runtimeLocation: "cloud",
};
const RESPONSES: HarnessGatewayModel = {
  providerKey: "custom:litellm",
  apis: ["chatCompletions", "responses"],
  runtimeLocation: "cloud",
};

describe("harnessOrgUpstreamProfile", () => {
  it("runs a gateway model on the org gateway profile, whatever the harness", () => {
    for (const id of ["claude-code", "codex", "copilot-cli", "opencode"]) {
      expect(harnessOrgUpstreamProfile(id, "custom:litellm/gpt-5.5")).toBe(
        "org-gateway",
      );
    }
  });

  it("runs a vendor model on the native profile of the API the harness speaks", () => {
    expect(
      harnessOrgUpstreamProfile("claude-code", "anthropic/claude-sonnet-4.5"),
    ).toBe("anthropic-native");
    expect(
      harnessOrgUpstreamProfile("opencode", "anthropic/claude-haiku-4.5"),
    ).toBe("anthropic-native");
    expect(harnessOrgUpstreamProfile("codex", "openai/gpt-5.5")).toBe(
      "openai-native",
    );
    expect(harnessOrgUpstreamProfile("copilot-cli", "openai/gpt-5.5")).toBe(
      "openai-native",
    );
    expect(harnessOrgUpstreamProfile("cursor", "cursor/auto")).toBeUndefined();
  });
});

describe("gatewayHarnessModel on a gateway that serves Anthropic Messages", () => {
  it("runs Claude Code and OpenCode on a mapped qualified model", () => {
    expect(
      gatewayHarnessModel("claude-code", {
        ...MESSAGES,
        modelId: "anthropic/claude-sonnet-4.5",
      }),
    ).toEqual({ modelId: "anthropic/claude-sonnet-4.5" });
    expect(
      gatewayHarnessModel("opencode", {
        ...MESSAGES,
        modelId: "anthropic/claude-haiku-4.5",
      }),
    ).toEqual({ modelId: "anthropic/claude-haiku-4.5" });
  });

  it("refuses Codex with the API it needs, though the model maps to OpenAI", () => {
    expect(
      gatewayHarnessModel("codex", { ...MESSAGES, modelId: "openai/gpt-5.5" }),
    ).toEqual({
      refusal:
        "This provider doesn't serve Responses, which Codex needs. Turn on Responses for it in Organization models, or choose another connection.",
    });
  });
});

describe("gatewayHarnessModel on a gateway that serves Responses", () => {
  it("runs Codex and Copilot CLI on a mapped qualified model", () => {
    const gpt = { ...RESPONSES, modelId: "openai/gpt-5.5" };
    expect(gatewayHarnessModel("codex", gpt)).toEqual({
      modelId: "openai/gpt-5.5",
    });
    expect(gatewayHarnessModel("copilot-cli", gpt)).toEqual({
      modelId: "openai/gpt-5.5",
    });
  });

  it("refuses Claude Code and OpenCode with the API they need", () => {
    for (const [id, label] of [
      ["claude-code", "Claude Code"],
      ["opencode", "OpenCode"],
    ] as const) {
      expect(
        gatewayHarnessModel(id, {
          ...RESPONSES,
          modelId: "anthropic/claude-haiku-4.5",
        }),
      ).toEqual({
        refusal: `This provider doesn't serve Anthropic Messages, which ${label} needs. Turn on Anthropic Messages for it in Organization models, or choose another connection.`,
      });
    }
  });
});

describe("gatewayHarnessModel on any gateway", () => {
  it("refuses an unmapped model with the mapping it needs", () => {
    expect(gatewayHarnessModel("claude-code", MESSAGES)).toEqual({
      refusal:
        "Map this provider model to a model in Organization models to use it with Claude Code.",
    });
  });

  it("refuses a mapped model the evidence doesn't support, unknown included", () => {
    expect(
      gatewayHarnessModel("claude-code", { ...MESSAGES, modelId: "openai/gpt-5.5" }),
    ).toEqual({
      refusal:
        "This model isn’t supported by Claude Code. Choose a supported model or switch clients.",
    });
    expect(
      gatewayHarnessModel("claude-code", {
        ...MESSAGES,
        modelId: "anthropic/claude-fable-5",
      }),
    ).toEqual({ refusal: expect.stringMatching(/not been verified/) });
    // At the runtime version the caller reports, not only the pinned one.
    expect(
      gatewayHarnessModel(
        "copilot-cli",
        { ...RESPONSES, modelId: "openai/gpt-5.5" },
        "1.1.0",
      ),
    ).toEqual({ refusal: expect.stringMatching(/isn’t supported/) });
  });

  it("refuses a gateway whose calls come from each user's Inspector", () => {
    expect(
      gatewayHarnessModel("claude-code", {
        ...MESSAGES,
        runtimeLocation: "local",
        modelId: "anthropic/claude-sonnet-4.5",
      }),
    ).toEqual({
      refusal:
        "This connection's calls come from each user's Inspector, so Claude Code can't run on it. Choose a connection whose calls come from MCPJam's servers.",
    });
  });

  it("refuses a harness with no organization path", () => {
    expect(
      gatewayHarnessModel("cursor", { ...MESSAGES, modelId: "anthropic/claude-sonnet-4.5" }),
    ).toEqual({ refusal: expect.stringMatching(/does not support organization/) });
  });
});

describe("gateway model names", () => {
  const connection = {
    providerKey: "custom:litellm",
    apis: ["anthropicMessages" as const],
    models: [
      { nativeModelId: "anthropic/claude-haiku-4-5", modelId: "anthropic/claude-haiku-4.5" },
      { nativeModelId: "house-model" },
    ],
  };

  it("reads the mapping of the model a name picks", () => {
    expect(gatewayModelFor(connection, "anthropic/claude-haiku-4-5")).toEqual({
      providerKey: "custom:litellm",
      apis: ["anthropicMessages"],
      modelId: "anthropic/claude-haiku-4.5",
    });
    expect(gatewayModelFor(connection, "house-model")).not.toHaveProperty(
      "modelId",
    );
  });

  it("names the gateway's model from either selection spelling", () => {
    expect(
      gatewayModelName("custom:litellm", {
        modelId: "custom:litellm/anthropic/claude-haiku-4-5",
        nativeModelId: "custom:litellm:anthropic/claude-haiku-4-5",
      }),
    ).toBe("anthropic/claude-haiku-4-5");
    expect(
      gatewayModelName("custom:litellm", { modelId: "custom:litellm/house-model" }),
    ).toBe("house-model");
  });

  it("gives lease start the gateway's own name as the native id", () => {
    const selection = {
      modelId: "custom:litellm/anthropic/claude-haiku-4-5",
      nativeModelId: "custom:litellm:anthropic/claude-haiku-4-5",
      source: "org" as const,
    };
    expect(gatewayLeaseSelection(selection)).toEqual({
      ...selection,
      nativeModelId: "anthropic/claude-haiku-4-5",
    });
    // Already a name, another gateway's row id, or a vendor selection: as is.
    for (const kept of [
      { modelId: "custom:litellm/gpt-5.5", nativeModelId: "gpt-5.5" },
      { modelId: "custom:litellm/gpt-5.5", nativeModelId: "custom:other:gpt-5.5" },
      { modelId: "anthropic/claude-sonnet-4.5", nativeModelId: "claude-sonnet-4-5" },
    ]) {
      expect(gatewayLeaseSelection(kept)).toBe(kept);
    }
  });
});
