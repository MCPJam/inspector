import { describe, expect, it } from "vitest";
import { SUPPORTED_MODELS, type ModelDefinition } from "@/shared/types";
import {
  emptyHostConfigInputV2,
  type HostConfigInputV2,
} from "../client-config-v2";
import { bindTemplateSeedToOrg } from "../org-bound-template-seed";

const chatgptSeed: HostConfigInputV2 = {
  ...emptyHostConfigInputV2(),
  hostStyle: "chatgpt",
  modelId: "openai/gpt-5.6-luna",
};

const orgRow = (
  id: string,
  provider: string,
  extra: Partial<ModelDefinition> = {},
) =>
  ({
    id,
    name: id,
    provider,
    hosted: false,
    orgProvider: { providerKey: provider, id: `orgprov_${provider}` },
    ...extra,
  }) as ModelDefinition;

const ORG_LUNA = orgRow("gpt-5.6-luna", "openai");
const ORG_GPT5 = orgRow("gpt-5", "openai");
const ORG_SONNET = orgRow("claude-sonnet-5", "anthropic");

const on = (models: ModelDefinition[], selectionsSupported = true) => ({
  requireOrgKeys: true,
  models,
  selectionsSupported,
});

describe("bindTemplateSeedToOrg (QA-25)", () => {
  it("policy off: the template is used exactly as it is", () => {
    const out = bindTemplateSeedToOrg(chatgptSeed, {
      requireOrgKeys: false,
      models: [ORG_LUNA],
      selectionsSupported: true,
    });
    expect(out).toEqual({ kind: "unchanged", input: chatgptSeed });
  });

  it("starts on the template's own model on the organization connection", () => {
    const out = bindTemplateSeedToOrg(chatgptSeed, on([ORG_SONNET, ORG_GPT5, ORG_LUNA]));
    expect(out.kind).toBe("bound");
    if (out.kind !== "bound") return;
    expect(out.input.modelId).toBe("openai/gpt-5.6-luna");
    expect(out.input.modelSelection).toMatchObject({
      modelId: "openai/gpt-5.6-luna",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "orgprov_openai" },
      nativeModelId: "gpt-5.6-luna",
    });
    // Everything else in the template is kept.
    expect(out.input.hostStyle).toBe("chatgpt");
  });

  it.each([[ORG_SONNET, ORG_GPT5], [ORG_SONNET]])(
    "requires an explicit choice when the template model is unavailable (%j)",
    (...models) => {
      expect(bindTemplateSeedToOrg(chatgptSeed, on(models))).toEqual({
        kind: "needs_choice",
        input: chatgptSeed,
      });
    },
  );

  it("does not substitute a model from the full Anthropic catalog", () => {
    const models = SUPPORTED_MODELS.filter((row) => row.provider === "anthropic")
      .map((row) => orgRow(String(row.id), "anthropic", row));
    const seed = { ...chatgptSeed, modelId: "anthropic/claude-haiku-5.5" };
    expect(bindTemplateSeedToOrg(seed, on(models))).toEqual({
      kind: "needs_choice",
      input: seed,
    });
  });

  it("selects the same connection regardless of row order", () => {
    const first = orgRow("gpt-5.6-luna", "openai", {
      orgProvider: { providerKey: "openai", id: "connection-a" },
    });
    const second = orgRow("gpt-5.6-luna", "openai", {
      orgProvider: { providerKey: "openai", id: "connection-b" },
    });
    for (const rows of [[first, second], [second, first]]) {
      expect(bindTemplateSeedToOrg(chatgptSeed, on(rows))).toMatchObject({
        kind: "bound",
        input: { modelSelection: { connectionRef: { id: "connection-a" } } },
      });
    }
  });

  it("requires a choice when the template model is disabled", () => {
    const locked = orgRow("gpt-5.6-luna", "openai", { disabled: true });
    expect(bindTemplateSeedToOrg(chatgptSeed, on([locked, ORG_SONNET]))).toEqual({
      kind: "needs_choice",
      input: chatgptSeed,
    });
  });

  it("never starts on a hosted row, even one the list still holds", () => {
    const hosted = {
      id: "openai/gpt-5.6-luna",
      name: "GPT-5.6 Luna",
      provider: "openai",
      hosted: true,
    } as ModelDefinition;
    expect(bindTemplateSeedToOrg(chatgptSeed, on([hosted]))).toEqual({
      kind: "needs_model",
    });
  });

  it("needs a model when the organization offers none the client can run", () => {
    expect(bindTemplateSeedToOrg(chatgptSeed, on([]))).toEqual({
      kind: "needs_model",
    });
  });

  it("needs a model where the deployment cannot store a selection", () => {
    expect(bindTemplateSeedToOrg(chatgptSeed, on([ORG_LUNA], false))).toEqual({
      kind: "needs_model",
    });
  });

  it("keeps a runtime-chosen model (Cursor Auto): the policy has no say over it", () => {
    const cursor = { ...chatgptSeed, hostStyle: "cursor", modelId: "cursor/auto" };
    expect(bindTemplateSeedToOrg(cursor, on([ORG_LUNA]))).toEqual({
      kind: "unchanged",
      input: cursor,
    });
  });

  it("a harness template only starts on its own vendor's organization models", () => {
    const claudeCode = {
      ...chatgptSeed,
      hostStyle: "claude-code",
      harness: "claude-code",
      modelId: "anthropic/claude-haiku-5.5",
    } as HostConfigInputV2;
    const out = bindTemplateSeedToOrg(claudeCode, on([ORG_LUNA]));
    expect(out).toEqual({ kind: "needs_model" });
  });
});
