import { describe, expect, it } from "vitest";
import {
  harnessChoiceRefusalReason,
  harnessPickerModels,
  harnessRowRefusalReason,
} from "../harness-model-locks";
import { buildAvailableModelsFromOrgConfig } from "@/components/chat-v2/shared/model-helpers";
import { modelSelectionFromDefinition } from "@/components/chat-v2/shared/model-selection";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import type { GatewayApi } from "@/shared/gateway-connection";
import type { ModelDefinition } from "@/shared/types";

// A LiteLLM gateway's models: one per harness family, one the evidence has not
// verified for any harness, and one the admin never mapped.
const MODELS = [
  { nativeModelId: "anthropic/claude-haiku-4-5", modelId: "anthropic/claude-haiku-4.5" },
  { nativeModelId: "gpt-5.5", modelId: "openai/gpt-5.5" },
  { nativeModelId: "fable", modelId: "anthropic/claude-fable-5" },
  { nativeModelId: "house-model" },
];

function gatewayRows(
  apis: GatewayApi[],
  runtimeLocation: "cloud" | "local" = "cloud",
): ModelDefinition[] {
  const gateway: OrgModelProvider = {
    id: "orgprov_litellm",
    providerKey: "custom:litellm",
    displayName: "LiteLLM",
    enabled: true,
    hasSecret: true,
    baseUrl: "https://litellm.example.com",
    runtimeLocation,
    modelIds: MODELS.map((model) => model.nativeModelId),
    apis,
    models: MODELS,
  };
  return buildAvailableModelsFromOrgConfig({ providers: [gateway] }, []);
}

/** Each gateway row's verdict on one harness: its model name, or the reason. */
function verdicts(rows: ModelDefinition[], harnessId: string) {
  return Object.fromEntries(
    harnessPickerModels(rows, { harnessId }).map((row) => [
      row.name.replace("LiteLLM / ", ""),
      row.disabled ? row.disabledReason : "runs",
    ]),
  );
}

const MAP_REASON = (label: string) =>
  `Map this provider model to a model in Organization models to use it with ${label}.`;
const API_REASON = (api: string, label: string) =>
  `This provider doesn't serve ${api}, which ${label} needs. Turn on ${api} for it in Organization models, or choose another connection.`;

describe("a gateway that serves Anthropic Messages", () => {
  const rows = gatewayRows(["chatCompletions", "anthropicMessages"]);

  it("runs Claude Code and OpenCode on the models mapped to ones they run", () => {
    expect(verdicts(rows, "claude-code")).toEqual({
      "anthropic/claude-haiku-4-5": "runs",
      "gpt-5.5":
        "This model isn’t supported by Claude Code. Choose a supported model or switch clients.",
      // Unverified is refused here, chat included: lease start refuses it.
      fable: expect.stringMatching(/not been verified for the Claude Code client/),
      "house-model": MAP_REASON("Claude Code"),
    });
    expect(verdicts(rows, "opencode")).toMatchObject({
      "anthropic/claude-haiku-4-5": "runs",
      "house-model": MAP_REASON("OpenCode"),
    });
  });

  it("refuses Codex the API it needs, on a model mapped to OpenAI too", () => {
    expect(verdicts(rows, "codex")).toEqual({
      "anthropic/claude-haiku-4-5": API_REASON("Responses", "Codex"),
      "gpt-5.5": API_REASON("Responses", "Codex"),
      fable: API_REASON("Responses", "Codex"),
      "house-model": API_REASON("Responses", "Codex"),
    });
  });
});

describe("a gateway that serves Responses", () => {
  const rows = gatewayRows(["responses"]);

  it("runs Codex and Copilot CLI on the model mapped to one they run", () => {
    for (const [harnessId, label] of [
      ["codex", "Codex"],
      ["copilot-cli", "GitHub Copilot CLI"],
    ] as const) {
      expect(verdicts(rows, harnessId)).toMatchObject({
        "gpt-5.5": "runs",
        "anthropic/claude-haiku-4-5": expect.stringMatching(/isn’t supported/),
        "house-model": MAP_REASON(label),
      });
    }
  });

  it("refuses Claude Code and OpenCode on a model mapped to Anthropic", () => {
    const haiku = rows.find((row) => row.name.endsWith("claude-haiku-4-5"))!;
    expect(harnessRowRefusalReason(haiku, { harnessId: "claude-code" }, "chat")).toBe(
      API_REASON("Anthropic Messages", "Claude Code"),
    );
    expect(harnessRowRefusalReason(haiku, { harnessId: "opencode" }, "eval")).toBe(
      API_REASON("Anthropic Messages", "OpenCode"),
    );
  });
});

it("refuses every harness on a gateway whose calls come from each user's Inspector", () => {
  const rows = gatewayRows(["anthropicMessages", "responses"], "local");
  expect(verdicts(rows, "claude-code")["anthropic/claude-haiku-4-5"]).toMatch(
    /calls come from each user's Inspector/,
  );
});

it("saves a gateway row as lease start reads it, slash names included", () => {
  const [haiku] = gatewayRows(["anthropicMessages"]);
  expect(modelSelectionFromDefinition(haiku!, undefined, "chat")).toMatchObject({
    modelId: "custom:litellm/anthropic/claude-haiku-4-5",
    source: "org",
    connectionRef: { kind: "orgProvider", id: "orgprov_litellm" },
  });
});

describe("a saved gateway choice", () => {
  const choice = (gateway?: Parameters<typeof harnessChoiceRefusalReason>[0]["gateway"]) => ({
    modelId: "custom:litellm/gpt-5.5",
    selection: { source: "org" as const },
    ...(gateway ? { gateway } : {}),
  });

  it("is judged on its gateway model when the caller holds the org config", () => {
    const responses = {
      providerKey: "custom:litellm",
      apis: ["responses" as const],
      modelId: "openai/gpt-5.5",
    };
    expect(harnessChoiceRefusalReason(choice(responses), { harnessId: "codex" }, "eval")).toBeUndefined();
    expect(
      harnessChoiceRefusalReason(choice(responses), { harnessId: "claude-code" }, "eval"),
    ).toBe(API_REASON("Anthropic Messages", "Claude Code"));
    expect(
      harnessChoiceRefusalReason(
        choice({ providerKey: "custom:litellm", apis: ["responses"] }),
        { harnessId: "codex" },
        "chat",
      ),
    ).toBe(MAP_REASON("Codex"));
  });

  it("is left to lease start without it, but never runs a harness with no org path", () => {
    expect(harnessChoiceRefusalReason(choice(), { harnessId: "codex" }, "eval")).toBeUndefined();
    expect(harnessChoiceRefusalReason(choice(), { harnessId: "cursor" }, "eval")).toMatch(
      /does not support organization provider keys/,
    );
  });
});
