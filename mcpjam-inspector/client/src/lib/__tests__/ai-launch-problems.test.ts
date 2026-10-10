import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  aiLaunchProblemsOf,
  aiLaunchProblemsSentence,
  aiLaunchRefusalCodeOf,
} from "../ai-launch-problems";

const problems = [
  {
    dependency: "target",
    label: "gpt-4o",
    code: "org_keys_required",
    reason: "gpt-4o is not a model from an organization provider.",
  },
  {
    dependency: "runtime",
    label: "codex",
    code: "org_runtime_unsupported",
    reason: "The codex runtime can't run on this organization's providers yet.",
  },
];

describe("aiLaunchProblemsOf", () => {
  it("reads a ConvexError's data", () => {
    const error = new ConvexError({
      code: "org_keys_required",
      message: "refused",
      problems,
    });
    expect(aiLaunchProblemsOf(error)).toEqual(problems);
    expect(aiLaunchRefusalCodeOf(error)).toBe("org_keys_required");
  });

  it("reads an HTTP body's details or top level", () => {
    expect(aiLaunchProblemsOf({ details: { problems } })).toEqual(problems);
    expect(aiLaunchProblemsOf({ code: "x", problems })).toEqual(problems);
    expect(
      aiLaunchProblemsOf(
        Object.assign(new Error("refused"), { details: { problems } }),
      ),
    ).toEqual(problems);
  });

  it("reads serialized data and drops malformed rows", () => {
    expect(
      aiLaunchProblemsOf({
        data: JSON.stringify({ problems: [...problems, { label: "x" }, 3] }),
      }),
    ).toEqual(problems);
  });

  it("is empty for anything else", () => {
    expect(aiLaunchProblemsOf(new Error("nope"))).toEqual([]);
    expect(aiLaunchProblemsOf(undefined)).toEqual([]);
    expect(aiLaunchProblemsOf({ problems: [] })).toEqual([]);
  });

  it("words the list as one paragraph", () => {
    expect(aiLaunchProblemsSentence(problems)).toBe(
      "This organization requires its own provider keys for AI features, and this run has dependencies that can't run on them. Model: gpt-4o is not a model from an organization provider. Runtime: The codex runtime can't run on this organization's providers yet.",
    );
  });
});
