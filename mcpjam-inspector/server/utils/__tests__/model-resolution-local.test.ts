import { describe, expect, it } from "vitest";
import type { ModelSelection } from "@mcpjam/sdk";
import {
  fallbackProhibitedRefusal,
  readStoredModelSelection,
  requestedModelSelection,
  resolveLocalModelSelection,
  wireModelIdForSelection,
} from "../model-resolution-local";

const none = { provider: "none", model: "none" } as const;
const noKeys = () => false;

const orgCustom: ModelSelection = {
  modelId: "custom:acme/llama-3",
  source: "org",
  connectionRef: { kind: "orgProvider", id: "orgprov_acme" },
  nativeModelId: "custom:acme:llama-3",
  fallback: none,
};

describe("resolveLocalModelSelection", () => {
  it("hosted → hosted rail, no local credential needed", () => {
    expect(
      resolveLocalModelSelection({
        selection: {
          modelId: "anthropic/claude-haiku-4.5",
          source: "hosted",
          fallback: none,
        },
        purpose: "evalTarget",
        hasOrgTarget: false,
        hasLocalKey: noKeys,
      }),
    ).toEqual({
      ok: true,
      plan: {
        rail: "hosted",
        wireModelId: "anthropic/claude-haiku-4.5",
        fallback: none,
      },
    });
  });

  it("org → org rail with the connection, executed with the native id", () => {
    const result = resolveLocalModelSelection({
      selection: orgCustom,
      purpose: "evalTarget",
      orgProviderKey: "custom:acme",
      hasOrgTarget: true,
      orgProviders: [{ providerKey: "custom:acme", modelIds: ["llama-3"] }],
      hasLocalKey: noKeys,
    });
    expect(result).toEqual({
      ok: true,
      plan: {
        rail: "org",
        wireModelId: "custom:acme:llama-3",
        providerKey: "custom:acme",
        connectionRef: { kind: "orgProvider", id: "orgprov_acme" },
        fallback: none,
      },
    });
  });

  it("org connection that no longer serves the model → invalid_model", () => {
    const result = resolveLocalModelSelection({
      selection: orgCustom,
      purpose: "evalTarget",
      orgProviderKey: "custom:acme",
      hasOrgTarget: true,
      orgProviders: [{ providerKey: "custom:acme", modelIds: ["other"] }],
      hasLocalKey: noKeys,
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusals[0]?.code).toBe("invalid_model");
  });

  it.each([
    ["no org target", { hasOrgTarget: false, orgProviderKey: "custom:acme" }],
    ["no provider key", { hasOrgTarget: true }],
    [
      "provider removed",
      {
        hasOrgTarget: true,
        orgProviderKey: "custom:acme",
        orgProviders: [{ providerKey: "openai" }],
      },
    ],
  ])("org: %s → credential_missing", (_label, extra) => {
    const result = resolveLocalModelSelection({
      selection: orgCustom,
      purpose: "evalTarget",
      hasLocalKey: noKeys,
      ...extra,
    });
    expect(!result.ok && result.refusals[0]?.code).toBe("credential_missing");
  });

  it("local: key present → local rail; key absent → credential_missing", () => {
    const selection: ModelSelection = {
      modelId: "openai/gpt-4o",
      source: "local",
      connectionRef: { kind: "localProvider", providerKey: "openai" },
      nativeModelId: "gpt-4o",
      fallback: none,
    };
    const ok = resolveLocalModelSelection({
      selection,
      purpose: "chat",
      hasOrgTarget: true,
      hasLocalKey: (key) => key === "openai",
    });
    expect(ok.ok && ok.plan).toMatchObject({
      rail: "local",
      wireModelId: "gpt-4o",
      providerKey: "openai",
    });
    const missing = resolveLocalModelSelection({
      selection,
      purpose: "chat",
      hasOrgTarget: true,
      hasLocalKey: noKeys,
    });
    expect(!missing.ok && missing.refusals[0]).toMatchObject({
      code: "credential_missing",
      evidence: { providerKey: "openai" },
    });
  });

  it("local Ollama needs no key", () => {
    const result = resolveLocalModelSelection({
      selection: {
        modelId: "ollama/llama3.2:latest",
        source: "local",
        connectionRef: { kind: "localProvider", providerKey: "ollama" },
        nativeModelId: "llama3.2:latest",
        fallback: none,
      },
      purpose: "evalTarget",
      hasOrgTarget: false,
      hasLocalKey: noKeys,
    });
    expect(result.ok && result.plan.wireModelId).toBe("llama3.2:latest");
  });
});

describe("fallbackProhibitedRefusal", () => {
  it("refuses a fallback when the selection permits none; legacy and openrouter pass", () => {
    const attempted = { rail: "gateway", fallbackRail: "openrouter" };
    expect(
      fallbackProhibitedRefusal(
        { modelId: "openai/gpt-4o", source: "hosted", fallback: none },
        attempted,
      ),
    ).toMatchObject({ code: "fallback_prohibited" });
    expect(
      fallbackProhibitedRefusal(
        {
          modelId: "openai/gpt-4o",
          source: "hosted",
          fallback: { provider: "openrouter", model: "none" },
        },
        attempted,
      ),
    ).toBeNull();
    expect(
      fallbackProhibitedRefusal(
        requestedModelSelection({ legacyModelId: "gpt-4o" }),
        attempted,
      ),
    ).toBeNull();
  });
});

describe("readStoredModelSelection", () => {
  it("drops a selection carrying a key-like field (reads as legacy)", () => {
    expect(
      readStoredModelSelection({
        modelId: "openai/gpt-4o",
        source: "hosted",
        fallback: none,
        apiKey: "sk-nope",
      }),
    ).toBeUndefined();
    expect(readStoredModelSelection(undefined)).toBeUndefined();
    expect(
      readStoredModelSelection({
        modelId: "openai/gpt-4o",
        source: "hosted",
        fallback: none,
      }),
    ).toEqual({ modelId: "openai/gpt-4o", source: "hosted", fallback: none });
  });

  it("wire id prefers nativeModelId", () => {
    expect(wireModelIdForSelection(orgCustom)).toBe("custom:acme:llama-3");
  });
});
