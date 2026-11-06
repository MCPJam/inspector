import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generate: vi.fn(), model: vi.fn(() => ({})) }));
vi.mock("ai", () => ({ generateObject: mocks.generate }));
vi.mock("../src/model-factory.js", () => ({
  createModelFromString: mocks.model,
}));
import { goalCompletionScorer } from "../src/scorers/goal-completion-scorer.js";
import type { ScorerContextV1 } from "../src/contract/types.js";
import { McpjamModelLeaseScope } from "../src/mcpjam-model-lease.js";

const context: ScorerContextV1 = {
  version: 1,
  scenario: { title: "Create ticket", scenarioKey: "ticket" },
  transcript: { toolCalls: [] },
  trace: {
    messages: [
      { role: "user", content: "Create a ticket" },
      { role: "tool", content: "x".repeat(20000) + "TAIL" },
    ],
  },
};
const options = {
  mode: "goalCompletion" as const,
  id: "goal",
  model: "openai/gpt-5.4-mini",
  apiKey: "test",
  modelLimits: {
    contextWindowTokens: 100000,
    outputTokens: 1000,
    supportedModalities: [],
  },
};
beforeEach(() => {
  mocks.model.mockClear();
  mocks.generate.mockReset();
  mocks.generate.mockResolvedValue({
    object: { score: 1, reason: "Done", rubricHits: [] },
  });
});

describe("local built-in goal completion", () => {
  it("forwards renewable credentials and the caller's project and lease owner without changing identity", async () => {
    let token = "first";
    const auth = { getAuth: async () => token };
    const scope = new McpjamModelLeaseScope({ auth });
    const base = { ...options, model: "mcpjam/openai/gpt-5.4", apiKey: "" };
    const original = goalCompletionScorer(base);
    const scorer = goalCompletionScorer({
      ...base,
      mcpjamAuth: auth,
      mcpjamProject: "project-123",
      mcpjamLeaseScope: scope,
      baseUrls: { mcpjam: "https://staging.mcpjam.com" },
    });
    expect(scorer.definition).toEqual(original.definition);
    const forwarded = mocks.model.mock.lastCall;
    expect(forwarded).toEqual([
      base.model,
      expect.objectContaining({
        apiKey: "",
        mcpjamAuth: auth,
        mcpjamProject: "project-123",
        mcpjamLeaseScope: scope,
        baseUrls: { mcpjam: "https://staging.mcpjam.com" },
      }),
    ]);
    token = "rotated";
    expect(await auth.getAuth()).toBe("rotated");
    const release = vi.spyOn(scope, "release");
    await scorer.score(context);
    expect(release).not.toHaveBeenCalled();
    await scope.release();
  });

  it("keeps provider credentials and custom endpoints unchanged", async () => {
    const baseUrls = { openai: "https://provider.example/v1" };
    await goalCompletionScorer({ ...options, baseUrls }).score(context);
    expect(mocks.model).toHaveBeenCalledWith(options.model, {
      apiKey: options.apiKey,
      baseUrls,
      customProviders: undefined,
      mcpjamAuth: undefined,
      mcpjamProject: undefined,
      mcpjamLeaseScope: undefined,
    });
  });

  it("uses the complete evidence and caps instructions-only scores", async () => {
    const scorer = goalCompletionScorer({
      ...options,
      rubric: { instructions: "Verify the ticket exists" },
      evidence: (ctx) => ({
        version: 1,
        trace: ctx.trace,
        toolDefinitions: [{ name: "uncalled" }],
      }),
    });
    const result = await scorer.score(context);
    expect(result).toMatchObject({ kind: "scored", value: 0.85 });
    const request = mocks.generate.mock.calls[0][0];
    expect(request.messages[0].content[0].text).toContain("TAIL");
    expect(request.messages[0].content[0].text).toContain("uncalled");
  });
  it("refuses overflow before spending on a model call", async () => {
    const scorer = goalCompletionScorer({
      ...options,
      modelLimits: { ...options.modelLimits, contextWindowTokens: 1000 },
    });
    await expect(scorer.score(context)).rejects.toMatchObject({
      code: "judge_context_limit",
    });
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

it("uses automatically captured tool catalogs without an evidence callback", async () => {
  const result = await goalCompletionScorer(options).score({
    ...context,
    toolDefinitions: [
      {
        name: "never_called",
        inputSchema: {
          type: "object",
          properties: { ticket: { type: "string" } },
        },
      },
    ],
    recordedContext: [{ systemPrompt: "system at execution" }],
  });
  expect(result.kind).toBe("scored");
  const prompt = mocks.generate.mock.calls[0][0].messages[0].content[0].text;
  expect(prompt).toContain("never_called");
  expect(prompt).toContain("system at execution");
});

it("sends captured images as model parts and preserves provenance through the public evaluator result", async () => {
  const { resolveScoreDefinition, finalizeScoreResult } =
    await import("../src/contract/derive.js");
  const { toEvaluatorResult, fromEvaluatorResult } =
    await import("@mcpjam/evaluators/internal/contract/evaluator-derive");
  const scorer = goalCompletionScorer({
    ...options,
    modelLimits: {
      ...options.modelLimits,
      supportedModalities: ["image"],
      artifactInputTokens: 2048,
    },
  });
  const raw = await scorer.score({
    ...context,
    gradingKey: "ticket#3",
    trace: {
      messages: [
        {
          role: "user",
          content: [{ type: "image", image: "data:image/png;base64,AQID" }],
        },
      ],
    },
  });
  const parts = mocks.generate.mock.calls[0][0].messages[0].content;
  expect(parts).toContainEqual({
    type: "image",
    image: "data:image/png;base64,AQID",
    mediaType: "image/png",
  });
  const finalized = finalizeScoreResult(
    resolveScoreDefinition(scorer.definition),
    raw
  );
  expect(fromEvaluatorResult(toEvaluatorResult(finalized))).toEqual(finalized);
  expect(finalized).toMatchObject({
    judgeTemplateVersion: 4,
    evidenceHash: expect.any(String),
    evidenceManifest: {
      artifactSources: [
        {
          modality: "image",
          mediaType: "image/png",
          sourceId: expect.any(String),
        },
      ],
    },
  });
});
