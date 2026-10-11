import { describe, expect, it } from "vitest";
import type { AiFeatureGroupReadiness } from "@/hooks/useOrgAiConfig";
import {
  EVALS_JUDGE_GUIDANCE,
  HARNESS_NOT_SUPPORTED_GUIDANCE,
  HARNESS_ORG_KEYS_GUIDANCE,
  NOT_SUPPORTED_YET_GUIDANCE,
  blockedBySentence,
  degradationSentence,
  featureGuidance,
  listedBlockers,
  orderedFeatures,
  orgAiModelCheckPresentation,
  orgProviderLabel,
  selectionModelLabel,
} from "../org-ai-config-presentation";

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

  it("suggests no fix for a feature that is not supported yet", () => {
    for (const id of [
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

describe("the default model editor's helpers", () => {
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
