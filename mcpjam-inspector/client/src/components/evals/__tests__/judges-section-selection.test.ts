import { describe, expect, it } from "vitest";
import type { ModelDefinition } from "@/shared/types";
import { judgeModelPatch } from "../judges-section";
import { MANAGED_DEFAULT_JUDGE_MODEL } from "@/components/shared/session-quality/judge-config";

const hosted: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "Claude Haiku 4.5",
  provider: "anthropic",
  hosted: true,
};
const orgOpenRouterTwin: ModelDefinition = {
  id: "anthropic/claude-haiku-4.5",
  name: "anthropic/claude-haiku-4.5",
  provider: "openrouter",
  hosted: false,
  orgProvider: { providerKey: "openrouter", id: "orgprov_1" },
};
const bareByok: ModelDefinition = {
  id: "gpt-4o",
  name: "GPT-4o",
  provider: "openai",
  hosted: false,
};

describe("judgeModelPatch", () => {
  it("writes the id and its selection together, with the judge fallback", () => {
    expect(
      judgeModelPatch("anthropic/claude-haiku-4.5", [
        hosted,
        orgOpenRouterTwin,
      ]),
    ).toEqual({
      judgeModel: "anthropic/claude-haiku-4.5",
      judgeSelection: {
        modelId: "anthropic/claude-haiku-4.5",
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      },
    });
  });

  it("saves the org connection when the org row is the one listed", () => {
    expect(
      judgeModelPatch("anthropic/claude-haiku-4.5", [orgOpenRouterTwin]),
    ).toMatchObject({
      judgeSelection: {
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_1" },
      },
    });
  });

  it("resolves a bare id like a stored choice: the hosted row, not the first id match", () => {
    expect(
      judgeModelPatch("anthropic/claude-haiku-4.5", [
        orgOpenRouterTwin,
        hosted,
      ]).judgeSelection,
    ).toMatchObject({ source: "hosted" });
  });

  it("saves exactly the row the picker hands over", () => {
    expect(
      judgeModelPatch(orgOpenRouterTwin, [hosted, orgOpenRouterTwin])
        .judgeSelection,
    ).toMatchObject({ source: "org" });
  });

  it("clears both for the managed default", () => {
    expect(judgeModelPatch(MANAGED_DEFAULT_JUDGE_MODEL, [hosted])).toEqual({
      judgeModel: undefined,
      judgeSelection: undefined,
    });
  });

  it("a bare-id row or an unknown id keeps the legacy id alone (and drops a stale selection)", () => {
    expect(judgeModelPatch("gpt-4o", [bareByok])).toEqual({
      judgeModel: "gpt-4o",
      judgeSelection: undefined,
    });
    expect(judgeModelPatch("some/unknown", [])).toEqual({
      judgeModel: "some/unknown",
      judgeSelection: undefined,
    });
  });

  it("writes the legacy id alone when the deployment does not store selections", () => {
    expect(
      judgeModelPatch("anthropic/claude-haiku-4.5", [hosted], false),
    ).toEqual({
      judgeModel: "anthropic/claude-haiku-4.5",
      judgeSelection: undefined,
    });
  });
});

describe("judgeModelPatch — reasoning effort", () => {
  const supporting: ModelDefinition = {
    ...hosted,
    supportedReasoningEfforts: ["low", "high"],
  };
  const plain: ModelDefinition = {
    id: "openai/gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    hosted: true,
  };

  it("keeps the previous effort on a judge that lists it", () => {
    const patch = judgeModelPatch(
      "anthropic/claude-haiku-4.5",
      [supporting],
      true,
      "high",
    );
    expect(patch.judgeSelection?.settings?.reasoningEffort).toBe("high");
  });

  it("drops it on a judge that does not, and never invents one", () => {
    expect(
      judgeModelPatch("openai/gpt-4o", [plain], true, "high").judgeSelection
        ?.settings,
    ).toBeUndefined();
    expect(
      judgeModelPatch("anthropic/claude-haiku-4.5", [supporting], true)
        .judgeSelection?.settings,
    ).toBeUndefined();
  });
});


describe("judgeModelPatch — organization judges", () => {
  const orgDirect: ModelDefinition = {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    hosted: false,
    orgProvider: { providerKey: "anthropic", id: "orgprov_anthropic" },
    judgeEligible: true,
  };

  it("saves a bare-id org row under its canonical id, with its connection", () => {
    expect(judgeModelPatch(orgDirect, [orgDirect])).toEqual({
      judgeModel: "anthropic/claude-sonnet-4.5",
      judgeSelection: {
        modelId: "anthropic/claude-sonnet-4.5",
        source: "org",
        connectionRef: { kind: "orgProvider", id: "orgprov_anthropic" },
        nativeModelId: "claude-sonnet-4-5",
        fallback: { provider: "none", model: "none" },
      },
    });
  });

  it("keeps the legacy id alone when the deployment does not store selections", () => {
    expect(judgeModelPatch(orgDirect, [orgDirect], false)).toEqual({
      judgeModel: "claude-sonnet-4-5",
      judgeSelection: undefined,
    });
  });
});
