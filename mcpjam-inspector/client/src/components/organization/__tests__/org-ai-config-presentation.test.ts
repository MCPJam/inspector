import { describe, expect, it } from "vitest";
import type { AiFeatureGroupReadiness } from "@/hooks/useOrgAiConfig";
import {
  buildOrgRoleSelection,
  degradationSentence,
  featureGuidance,
  listedBlockers,
  orderedFeatures,
  orgProviderLabel,
  roleModelIds,
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
  const operations = [
    {
      operation: "text_analysis" as const,
      status: "unconfigured" as const,
      role: "smart" as const,
    },
    {
      operation: "typed_decision" as const,
      status: "unconfigured" as const,
      role: "fast" as const,
    },
  ];

  it("points at Default model roles when a provider exists and a role model is missing", () => {
    const insights = feature({ id: "insights", blockedBy: ["text_analysis"] });
    expect(
      featureGuidance(insights, {
        operations,
        eligibleConnectionIds: ["conn_1"],
        canManage: true,
      }),
    ).toBe("Choose the organization's Smart model in Default model roles.");
    expect(
      featureGuidance(insights, {
        operations,
        eligibleConnectionIds: ["conn_1"],
        canManage: false,
      }),
    ).toBe(
      "Ask an organization admin to choose the organization's Smart model.",
    );
  });

  it("names every missing role once", () => {
    expect(
      featureGuidance(
        feature({
          id: "insights",
          blockedBy: ["typed_decision", "text_analysis"],
        }),
        { operations, eligibleConnectionIds: ["conn_1"], canManage: true },
      ),
    ).toBe(
      "Choose the organization's Fast and Smart models in Default model roles.",
    );
  });

  it("asks for a provider only when there is no eligible one", () => {
    const insights = feature({ id: "insights", blockedBy: ["text_analysis"] });
    for (const eligibleConnectionIds of [[], undefined]) {
      expect(
        featureGuidance(insights, {
          operations,
          eligibleConnectionIds,
          canManage: true,
        }),
      ).toBe("Add or configure an organization provider.");
    }
  });

  it("keeps the status guidance for everything else", () => {
    expect(
      featureGuidance(feature({ id: "ask_mcpjam", status: "unsupported" }), {
        operations,
        eligibleConnectionIds: ["conn_1"],
        canManage: true,
      }),
    ).toBe("This feature can't run on organization providers yet.");
    expect(
      featureGuidance(feature({ id: "chat", status: "ready" }), {
        operations,
        canManage: true,
      }),
    ).toBeNull();
  });
});

describe("listedBlockers", () => {
  it("drops a blocker that is only the feature itself", () => {
    expect(
      listedBlockers(
        feature({
          id: "ask_mcpjam",
          status: "unsupported",
          blockedBy: ["agent_chat"],
        }),
      ),
    ).toEqual([]);
    expect(
      listedBlockers(
        feature({
          id: "harness",
          status: "unsupported",
          blockedBy: ["harness_runtime"],
        }),
      ),
    ).toEqual([]);
  });

  it("keeps blockers that say something", () => {
    expect(
      listedBlockers(feature({ id: "evals", blockedBy: ["judge"] })),
    ).toEqual(["judge"]);
    expect(
      listedBlockers(
        feature({ id: "chat", blockedBy: ["chat", "text_analysis"] }),
      ),
    ).toEqual(["chat", "text_analysis"]);
    expect(
      listedBlockers(
        feature({ id: "evals", status: "ready", blockedBy: ["judge"] }),
      ),
    ).toEqual([]);
  });
});

describe("roleModelIds", () => {
  it("prefixes the provider and keeps the provider's own id as native", () => {
    expect(roleModelIds("openai", "gpt-5-mini")).toEqual({
      modelId: "openai/gpt-5-mini",
      nativeModelId: "gpt-5-mini",
    });
  });

  it("spells Anthropic's dashed versions the catalog way", () => {
    expect(roleModelIds("anthropic", "claude-haiku-4-5")).toEqual({
      modelId: "anthropic/claude-haiku-4.5",
      nativeModelId: "claude-haiku-4-5",
    });
    // Dated ids are not version-shaped and pass through.
    expect(roleModelIds("anthropic", "claude-3-5-sonnet-20241022")).toEqual({
      modelId: "anthropic/claude-3-5-sonnet-20241022",
      nativeModelId: "claude-3-5-sonnet-20241022",
    });
  });

  it("uses canonical vendor prefixes", () => {
    expect(roleModelIds("xai", "grok-4")?.modelId).toBe("x-ai/grok-4");
    expect(roleModelIds("mistral", "mistral-large-latest")?.modelId).toBe(
      "mistralai/mistral-large-latest",
    );
    expect(roleModelIds("z-ai", "glm-4.6")?.modelId).toBe("z-ai/glm-4.6");
  });

  it("keeps an Azure deployment name as the native id", () => {
    expect(roleModelIds("azure", "prod-gpt51")).toEqual({
      modelId: "azure/prod-gpt51",
      nativeModelId: "prod-gpt51",
    });
  });

  it("drops a pasted provider prefix from the native id", () => {
    expect(roleModelIds("openai", "openai/gpt-5")).toEqual({
      modelId: "openai/gpt-5",
      nativeModelId: "gpt-5",
    });
    expect(roleModelIds("xai", "x-ai/grok-4")).toEqual({
      modelId: "x-ai/grok-4",
      nativeModelId: "grok-4",
    });
  });

  it("namespaces a custom provider's models under its key", () => {
    expect(roleModelIds("custom:Acme", "acme-large")).toEqual({
      modelId: "custom:acme/acme-large",
      nativeModelId: "acme-large",
    });
  });

  it("returns null for an empty model", () => {
    expect(roleModelIds("openai", "   ")).toBeNull();
  });
});

describe("buildOrgRoleSelection", () => {
  it("builds an org selection that never falls back", () => {
    expect(
      buildOrgRoleSelection(
        { id: "conn_1", providerKey: "openai" },
        " text-embedding-3-small ",
      ),
    ).toEqual({
      modelId: "openai/text-embedding-3-small",
      source: "org",
      connectionRef: { kind: "orgProvider", id: "conn_1" },
      nativeModelId: "text-embedding-3-small",
      fallback: { provider: "none", model: "none" },
    });
  });

  it("refuses a connection without an id or a model that is not an id", () => {
    expect(
      buildOrgRoleSelection({ providerKey: "openai" }, "gpt-5"),
    ).toBeNull();
    expect(
      buildOrgRoleSelection({ id: "conn_1", providerKey: "openai" }, "gpt 5"),
    ).toBeNull();
  });
});

describe("presentation", () => {
  it("never says text insights need embeddings", () => {
    expect(degradationSentence("insights", "embedding")).toBe(
      "Session map unavailable; text insights still run",
    );
  });

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
        enabled: true,
        hasSecret: true,
      }),
    ).toBe("acme");
    expect(
      orgProviderLabel({
        providerKey: "custom:acme",
        displayName: "Acme Gateway",
        enabled: true,
        hasSecret: true,
      }),
    ).toBe("Acme Gateway");
  });

  it("shows the native id only when it differs from the canonical model", () => {
    expect(
      selectionModelLabel({
        modelId: "openai/gpt-5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "c" },
        nativeModelId: "gpt-5",
        fallback: { provider: "none", model: "none" },
      }),
    ).toBe("openai/gpt-5");
    expect(
      selectionModelLabel({
        modelId: "anthropic/claude-haiku-4.5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "c" },
        nativeModelId: "claude-haiku-4-5",
        fallback: { provider: "none", model: "none" },
      }),
    ).toBe("anthropic/claude-haiku-4.5 (claude-haiku-4-5)");
  });
});
