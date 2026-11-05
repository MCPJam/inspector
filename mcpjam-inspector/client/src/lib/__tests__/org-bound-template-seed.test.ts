import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
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
    expect(out.via).toBe("template");
    expect(out.row).toBe(ORG_LUNA);
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

  it("falls back to the first model from the template's provider", () => {
    const out = bindTemplateSeedToOrg(chatgptSeed, on([ORG_SONNET, ORG_GPT5]));
    expect(out).toMatchObject({ kind: "bound", via: "firstConfigured", row: ORG_GPT5 });
    if (out.kind === "bound") expect(out.input.modelId).toBe("openai/gpt-5");
  });

  it("then to the first listed model", () => {
    const out = bindTemplateSeedToOrg(chatgptSeed, on([ORG_SONNET]));
    expect(out).toMatchObject({ kind: "bound", via: "firstConfigured", row: ORG_SONNET });
    if (out.kind === "bound") {
      expect(out.input.modelId).toBe("anthropic/claude-sonnet-5");
      expect(out.input.modelSelection?.source).toBe("org");
    }
  });

  it("never starts on a disabled (locked) row", () => {
    const locked = orgRow("gpt-5.6-luna", "openai", { disabled: true });
    const out = bindTemplateSeedToOrg(chatgptSeed, on([locked, ORG_SONNET]));
    expect(out).toMatchObject({ kind: "bound", row: ORG_SONNET });
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
