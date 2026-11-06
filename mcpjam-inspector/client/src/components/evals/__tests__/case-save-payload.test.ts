import { describe, expect, it } from "vitest";
import type { TestStep } from "@/shared/steps";
import {
  buildCaseSavePayload,
  buildDraftTestCase,
  type CaseSaveForm,
} from "../case-save-payload";
import type { EvalCase } from "../types";

const steps: TestStep[] = [
  { id: "p1", kind: "prompt", prompt: "Draw a box" },
  {
    id: "a1",
    kind: "assert",
    assertion: {
      type: "toolCalledWith",
      toolName: "create_view",
      args: { args: {} },
    },
  },
];

const form = (over: Partial<CaseSaveForm> = {}): CaseSaveForm => ({
  title: "Case",
  runs: 3,
  steps,
  ...over,
});

describe("buildCaseSavePayload", () => {
  it.each([
    {
      name: "inherit envelope sends an empty list",
      form: form({
        predicates: {
          mode: "inherit",
          list: [{ type: "noToolErrors" }],
        },
      }),
      check: (p: ReturnType<typeof buildCaseSavePayload>) =>
        expect(p.predicates).toEqual({ mode: "inherit", list: [] }),
    },
    {
      name: "expectedOutput is trimmed",
      form: form({ expectedOutput: "  two boxes  " }),
      check: (p: ReturnType<typeof buildCaseSavePayload>) =>
        expect(p.expectedOutput).toBe("two boxes"),
    },
    {
      name: '"" is kept to clear expectedOutput',
      form: form({ expectedOutput: "" }),
      check: (p: ReturnType<typeof buildCaseSavePayload>) =>
        expect(p.expectedOutput).toBe(""),
    },
    {
      name: "judgeConfigOverride is omitted when undefined",
      form: form(),
      check: (p: ReturnType<typeof buildCaseSavePayload>) =>
        expect("judgeConfigOverride" in p).toBe(false),
    },
  ])("$name", ({ form: input, check }) => {
    check(buildCaseSavePayload(input, { isNegativeTest: false }));
  });

  it("a negative case sends no expected tool calls", () => {
    const positive = buildCaseSavePayload(form(), { isNegativeTest: false });
    const negative = buildCaseSavePayload(form(), { isNegativeTest: true });
    expect(positive.expectedToolCalls.length).toBeGreaterThan(0);
    expect(negative.expectedToolCalls).toEqual([]);
    expect(negative.isNegativeTest).toBe(true);
    expect(negative.query).toBe("Draw a box");
  });
});

describe("buildDraftTestCase", () => {
  it("is an untitled case with the suite's models", () => {
    const cases = [
      { models: [{ provider: "openai", model: "openai/gpt-5.4-mini" }] },
    ] as Pick<EvalCase, "models">[];
    const draft = buildDraftTestCase("draft:prompt", cases as EvalCase[]);
    expect(draft).toMatchObject({
      _id: "draft:prompt",
      title: "Untitled test case",
      runs: 5,
      models: [{ provider: "openai", model: "openai/gpt-5.4-mini" }],
    });
  });

  it("falls back to the default model for an empty suite", () => {
    expect(buildDraftTestCase("draft:prompt", undefined).models).toEqual([
      { model: "anthropic/claude-haiku-4.5", provider: "anthropic" },
    ]);
  });
});
