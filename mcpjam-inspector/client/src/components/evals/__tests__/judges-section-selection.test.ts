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
});
