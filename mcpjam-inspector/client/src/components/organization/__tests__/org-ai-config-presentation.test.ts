import { describe, expect, it } from "vitest";
import type { AiFeatureGroupReadiness } from "@/hooks/useOrgAiConfig";
import {
  EVALS_JUDGE_GUIDANCE,
  HARNESS_NOT_SUPPORTED_GUIDANCE,
  HARNESS_ORG_KEYS_GUIDANCE,
  NOT_SUPPORTED_YET_GUIDANCE,
  blockedBySentence,
  buildOrgModelSelection,
  degradationSentence,
  featureGuidance,
  listedBlockers,
  listedModelFitsKind,
  orderedFeatures,
  orgAiModelCheckPresentation,
  orgModelIds,
  orgProviderLabel,
  selectionModelLabel,
} from "../org-ai-config-presentation";
import { modelSelectionFromDefinition } from "@/components/chat-v2/shared/model-selection";

function feature(
  overrides: Partial<AiFeatureGroupReadiness> &
    Pick<AiFeatureGroupReadiness, "id">,
): AiFeatureGroupReadiness {
  return {
    label: overrides.id,
    status: "unconfigured",
    blockedBy: [],
    degradedBy: [],
    ...overrides,
  };
}

describe("featureGuidance", () => {
  it("asks for a direct cloud provider when there is no eligible one", () => {
    const chat = feature({ id: "chat", blockedBy: ["chat"] });
    for (const eligibleConnectionIds of [[], undefined]) {
      expect(
        featureGuidance(chat, { eligibleConnectionIds, canManage: true }),
      ).toBe("Add a direct cloud provider below.");
    }
    expect(
      featureGuidance(chat, { eligibleConnectionIds: [], canManage: false }),
    ).toBe("Ask an organization admin to add a direct cloud provider.");
  });

  it("says the providers can't serve a feature when one exists but none fits", () => {
    expect(
      featureGuidance(feature({ id: "chat", blockedBy: ["chat"] }), {
        eligibleConnectionIds: ["conn_1"],
        canManage: true,
      }),
    ).toBe(
      "None of the organization's providers can serve this feature. Add a direct cloud provider that can.",
    );
  });

  it("asks evals for a judge choice, ready or not", () => {
    expect(
      featureGuidance(feature({ id: "evals", status: "ready" }), {
        eligibleConnectionIds: ["conn_1"],
        canManage: true,
      }),
    ).toBe(EVALS_JUDGE_GUIDANCE);
    expect(
      featureGuidance(
        feature({ id: "evals", blockedBy: ["eval_target", "judge"] }),
        { eligibleConnectionIds: [], canManage: true },
      ),
    ).toBe(
      "Add a direct cloud provider below. Then choose a judge model from it for each suite.",
    );
    expect(
      featureGuidance(
        feature({ id: "evals", blockedBy: ["eval_target", "judge"] }),
        { eligibleConnectionIds: [], canManage: false },
      ),
    ).toBe(
      "Ask an organization admin to add a direct cloud provider. Then choose a judge model from it for each suite.",
    );
  });

  it("names turning the setting off, never a provider, for a feature that is not supported yet", () => {
    expect(NOT_SUPPORTED_YET_GUIDANCE).toBe(
      "This feature can't run on organization providers yet. An organization admin can turn this setting off to run it on MCPJam-provided models.",
    );
    for (const id of [
      "swarms",
      "insights",
      "generation",
      "session_map",
      "transcription",
      "ask_mcpjam",
    ] as const) {
      for (const canManage of [true, false]) {
        expect(
          featureGuidance(feature({ id, status: "unsupported" }), {
            eligibleConnectionIds: ["conn_1"],
            canManage,
          }),
        ).toBe(NOT_SUPPORTED_YET_GUIDANCE);
      }
    }
  });

  it("names the vendor each harness runtime runs on, and what doesn't count", () => {
    expect(
      featureGuidance(feature({ id: "harness", status: "ready" }), {
        eligibleConnectionIds: ["conn_1"],
        canManage: true,
      }),
    ).toBe(
      "Claude Code runs on an Anthropic provider and Codex on an OpenAI provider.",
    );
    expect(HARNESS_ORG_KEYS_GUIDANCE).not.toMatch(/MCPJam/);
    for (const status of ["unconfigured", "unsupported"] as const) {
      expect(
        featureGuidance(feature({ id: "harness", status }), {
          eligibleConnectionIds: ["conn_1"],
          canManage: true,
        }),
      ).toBe(
        "Add a direct Anthropic provider for Claude Code or an OpenAI provider for Codex below. Custom base URLs, local runtimes and models the MCPJam SDK calls directly aren't supported.",
      );
      expect(
        featureGuidance(feature({ id: "harness", status }), {
          eligibleConnectionIds: [],
          canManage: false,
        }),
      ).toBe(
        `Ask an organization admin to add a direct Anthropic provider for Claude Code or an OpenAI provider for Codex. ${HARNESS_NOT_SUPPORTED_GUIDANCE}`,
      );
    }
    // A rejected key is the general fix.
    expect(
      featureGuidance(
        feature({ id: "harness", status: "invalid_credentials" }),
        { canManage: true },
      ),
    ).toBe(
      "The provider rejected its stored credentials. Update the key below.",
    );
  });

  it("names the key fix for rejected credentials, by audience", () => {
    const transcription = feature({
      id: "transcription",
      status: "invalid_credentials",
    });
    expect(featureGuidance(transcription, { canManage: true })).toBe(
      "The provider rejected its stored credentials. Update the key below.",
    );
    expect(featureGuidance(transcription, { canManage: false })).toBe(
      "The provider rejected its stored credentials. Ask an organization admin to update the key.",
    );
  });

  it("says nothing for a ready feature other than evals", () => {
    expect(
      featureGuidance(feature({ id: "chat", status: "ready" }), {
        canManage: true,
      }),
    ).toBeNull();
  });
});

describe("listedBlockers", () => {
  it("never names the feature itself", () => {
    expect(
      listedBlockers(
        feature({
          id: "ask_mcpjam",
          status: "unconfigured",
          blockedBy: ["agent_chat"],
        }),
      ),
    ).toEqual([]);
    expect(
      listedBlockers(
        feature({ id: "chat", blockedBy: ["chat", "text_analysis"] }),
      ),
    ).toEqual(["text_analysis"]);
  });

  it("lists nothing for a feature that is not supported yet", () => {
    expect(
      listedBlockers(
        feature({
          id: "insights",
          status: "unsupported",
          blockedBy: ["text_analysis"],
        }),
      ),
    ).toEqual([]);
    expect(
      listedBlockers(
        feature({
          id: "transcription",
          status: "unsupported",
          blockedBy: ["speech_transcription"],
        }),
      ),
    ).toEqual([]);
  });

  it("keeps blockers that say something", () => {
    expect(
      listedBlockers(
        feature({ id: "evals", blockedBy: ["eval_target", "judge"] }),
      ),
    ).toEqual(["eval_target", "judge"]);
    expect(
      listedBlockers(
        feature({ id: "evals", status: "ready", blockedBy: ["judge"] }),
      ),
    ).toEqual([]);
  });
});

describe("blockedBySentence", () => {
  it("joins the blockers in plain English, with no role names", () => {
    expect(blockedBySentence(["judge"])).toBe("Blocked by grading");
    expect(blockedBySentence(["eval_target", "judge"])).toBe(
      "Blocked by the eval target model and grading",
    );
    expect(blockedBySentence([])).toBeNull();
  });
});

describe("degradationSentence", () => {
  it("never says text insights need embeddings", () => {
    expect(degradationSentence("insights", "embedding")).toBe(
      "Session map unavailable; text insights still run",
    );
  });

  it("says an operation that isn't supported yet is not supported yet", () => {
    expect(degradationSentence("insights", "embedding", "unsupported")).toBe(
      "Session map not supported yet; text insights still run",
    );
    expect(degradationSentence("evals", "text_analysis", "unsupported")).toBe(
      "Automatic findings not supported yet; runs and grading still complete",
    );
  });
});

describe("orgModelIds", () => {
  it("prefixes the provider and keeps the provider's own id as native", () => {
    expect(orgModelIds("openai", "gpt-5-mini")).toEqual({
      modelId: "openai/gpt-5-mini",
      nativeModelId: "gpt-5-mini",
    });
  });

  it("spells Anthropic's dashed versions the catalog way", () => {
    expect(orgModelIds("anthropic", "claude-haiku-4-5")).toEqual({
      modelId: "anthropic/claude-haiku-4.5",
      nativeModelId: "claude-haiku-4-5",
    });
    // Dated ids are not version-shaped and pass through.
    expect(orgModelIds("anthropic", "claude-3-5-sonnet-20241022")).toEqual({
      modelId: "anthropic/claude-3-5-sonnet-20241022",
      nativeModelId: "claude-3-5-sonnet-20241022",
    });
  });

  it("uses canonical vendor prefixes", () => {
    expect(orgModelIds("xai", "grok-4")?.modelId).toBe("x-ai/grok-4");
    expect(orgModelIds("mistral", "mistral-large-latest")?.modelId).toBe(
      "mistralai/mistral-large-latest",
    );
    expect(orgModelIds("z-ai", "glm-4.6")?.modelId).toBe("z-ai/glm-4.6");
  });

  it("keeps an Azure deployment name as the native id", () => {
    expect(orgModelIds("azure", "prod-gpt51")).toEqual({
      modelId: "azure/prod-gpt51",
      nativeModelId: "prod-gpt51",
    });
  });

  it("drops a pasted provider prefix from the native id", () => {
    expect(orgModelIds("openai", "openai/gpt-5")).toEqual({
      modelId: "openai/gpt-5",
      nativeModelId: "gpt-5",
    });
    expect(orgModelIds("xai", "x-ai/grok-4")).toEqual({
      modelId: "x-ai/grok-4",
      nativeModelId: "grok-4",
    });
  });

  it("returns null for an empty model", () => {
    expect(orgModelIds("openai", "   ")).toBeNull();
  });

  it("saves the id a model picker saves for the same connection's row", () => {
    for (const [providerKey, typed] of [
      ["openai", "gpt-5"],
      ["anthropic", "claude-sonnet-4-5"],
      ["meta", "llama-4-scout"],
    ] as const) {
      // The row a picker lists for this model on the org connection.
      const picked = modelSelectionFromDefinition(
        {
          id: typed,
          name: typed,
          provider: providerKey,
          hosted: false,
          orgProvider: { providerKey, id: "conn_1" },
        },
        undefined,
        "analysis",
      );
      expect(picked).not.toBeNull();
      expect(
        buildOrgModelSelection({ id: "conn_1", providerKey }, typed)?.modelId,
      ).toBe(picked!.modelId);
    }
    // A second prefix table used to save these as `meta/…` and `alibaba/…`.
    expect(orgModelIds("meta", "llama-4-scout")?.modelId).toBe(
      "meta-llama/llama-4-scout",
    );
    expect(orgModelIds("alibaba", "qwen-3-32b")?.modelId).toBe(
      "qwen/qwen-3-32b",
    );
  });
});

describe("buildOrgModelSelection", () => {
  it("builds an org selection that never falls back", () => {
    expect(
      buildOrgModelSelection(
        { id: "conn_1", providerKey: "openai" },
        " gpt-5-mini ",
      ),
    ).toEqual({
      modelId: "openai/gpt-5-mini",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "conn_1" },
      nativeModelId: "gpt-5-mini",
      fallback: { provider: "none", model: "none" },
    });
  });

  it.each([
    ["google", "models/gemini-2.5-flash"],
    ["openai", "meta-llama/Llama-4"],
    ["bedrock", "arn:aws:bedrock:region:account:inference-profile/model"],
  ])("keeps %s's namespace around a native path", (providerKey, nativeModelId) => {
    expect(orgModelIds(providerKey, nativeModelId)).toEqual({
      modelId: `${providerKey}/${nativeModelId}`,
      nativeModelId,
    });
  });

  it("refuses a connection without an id or a model that is not an id", () => {
    expect(
      buildOrgModelSelection({ providerKey: "openai" }, "gpt-5"),
    ).toBeNull();
    expect(
      buildOrgModelSelection({ id: "conn_1", providerKey: "openai" }, "gpt 5"),
    ).toBeNull();
  });
});

describe("the default model editor's helpers", () => {
  it("suggests listed models that fit the kind", () => {
    expect(listedModelFitsKind("gpt-5-mini", "default")).toBe(true);
    expect(listedModelFitsKind("text-embedding-3-small", "default")).toBe(
      false,
    );
    expect(listedModelFitsKind("text-embedding-3-small", "embedding")).toBe(
      true,
    );
    expect(listedModelFitsKind("gpt-4o-mini-transcribe", "transcription")).toBe(
      true,
    );
  });

  it("reads a test's result", () => {
    expect(orgAiModelCheckPresentation({ ok: true, checkedAt: 1 })).toEqual({
      label: "Passed",
      tone: "success",
    });
    expect(
      orgAiModelCheckPresentation({
        ok: false,
        code: "provider_auth_failed",
        checkedAt: 1,
      }).label,
    ).toBe("Credentials rejected");
    for (const code of ["provider_unavailable", "timeout", "http_429"]) {
      expect(
        orgAiModelCheckPresentation({ ok: false, code, checkedAt: 1 }).label,
      ).toBe("Provider unavailable");
    }
    expect(
      orgAiModelCheckPresentation({
        ok: false,
        code: "invalid_model",
        checkedAt: 1,
      }).label,
    ).toBe("Refused");
    expect(orgAiModelCheckPresentation({ ok: false, checkedAt: 1 }).label).toBe(
      "Failed",
    );
  });

  it.each([
    ["http_400", "Refused", "destructive"],
    ["http_401", "Credentials rejected", "destructive"],
    ["http_403", "Credentials rejected", "destructive"],
    ["http_404", "Refused", "destructive"],
    ["http_408", "Provider unavailable", "warning"],
    ["http_429", "Provider unavailable", "warning"],
    ["http_500", "Provider unavailable", "warning"],
    ["http_503", "Provider unavailable", "warning"],
  ])("classifies HTTP check %s as %s", (code, label, tone) => {
    expect(orgAiModelCheckPresentation({ ok: false, code, checkedAt: 1 })).toEqual({
      label,
      tone,
    });
  });

  it("names connections the way the provider list does", () => {
    expect(
      orgProviderLabel({
        providerKey: "azure",
        enabled: true,
        hasSecret: true,
      }),
    ).toBe("Azure OpenAI");
    expect(
      orgProviderLabel({
        providerKey: "custom:acme",
        displayName: "Acme Gateway",
        enabled: true,
        hasSecret: true,
      }),
    ).toBe("Acme Gateway");
  });

  it("shows the provider's own id only when it differs", () => {
    expect(
      selectionModelLabel({
        modelId: "anthropic/claude-sonnet-4.5",
        source: "org",
        nativeModelId: "claude-sonnet-4-5",
        fallback: { provider: "none", model: "none" },
      }),
    ).toBe("anthropic/claude-sonnet-4.5 (claude-sonnet-4-5)");
    expect(
      selectionModelLabel({
        modelId: "openai/gpt-5",
        source: "org",
        nativeModelId: "gpt-5",
        fallback: { provider: "none", model: "none" },
      }),
    ).toBe("openai/gpt-5");
  });
});

describe("orderedFeatures", () => {
  it("orders known features first and keeps unknown ones", () => {
    const ids = orderedFeatures([
      {
        id: "future" as never,
        label: "Future",
        status: "ready",
        blockedBy: [],
        degradedBy: [],
      },
      {
        id: "insights",
        label: "Insights",
        status: "ready",
        blockedBy: [],
        degradedBy: [],
      },
      {
        id: "chat",
        label: "Chat",
        status: "ready",
        blockedBy: [],
        degradedBy: [],
      },
    ]).map((f) => f.id);
    expect(ids).toEqual(["chat", "insights", "future"]);
  });
});
