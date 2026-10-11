import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  AI_LAUNCH_REFUSED_HEADLINE,
  aiLaunchDependencyTitle,
  aiLaunchProblemsOf,
  aiLaunchProblemsSentence,
  aiLaunchRefusalCodeOf,
  aiLaunchRefusalOf,
  aiLaunchRefusalSentence,
} from "../ai-launch-problems";

const problems = [
  {
    dependency: "target",
    label: "gpt-4o",
    code: "org_keys_required",
    reason: "gpt-4o is not a model from an organization provider.",
  },
  // Codex runs on the organization's own OpenAI key, never on MCPJam's.
  {
    dependency: "runtime",
    label: "Codex",
    code: "org_keys_required",
    reason: "Codex runs only on an organization OpenAI provider.",
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
      "This run can't start yet. Fix the following, then start it again. Model: gpt-4o is not a model from an organization provider. Runtime: Codex runs only on an organization OpenAI provider.",
    );
  });
});

describe("aiLaunchDependencyTitle", () => {
  it("titles each known dependency and falls back for a new one", () => {
    expect(aiLaunchDependencyTitle("persona")).toBe("Simulated user");
    expect(aiLaunchDependencyTitle("judge")).toBe("Judge");
    expect(aiLaunchDependencyTitle("toString")).toBe("Dependency");
  });
});

describe("aiLaunchRefusalOf", () => {
  it("is the headline over the backend's list", () => {
    // Each item names its own fix; the headline says what to do with them.
    expect(AI_LAUNCH_REFUSED_HEADLINE).toBe(
      "This run can't start yet. Fix the items below, then start it again.",
    );
    expect(aiLaunchRefusalOf({ code: "org_keys_required", problems })).toEqual({
      message: AI_LAUNCH_REFUSED_HEADLINE,
      problems,
    });
  });

  it("reads a policy refusal with no list as the shared copy", () => {
    expect(
      aiLaunchRefusalOf(
        new ConvexError({
          code: "org_runtime_unsupported",
          message: "org_runtime_unsupported",
        }),
      ),
    ).toEqual({
      message:
        "This feature can't run on the organization's providers yet, so it is unavailable while the organization requires its own keys.",
      problems: [],
    });
  });

  it("leaves every other failure, and a bare credential_missing, alone", () => {
    expect(aiLaunchRefusalOf(new Error("nope"))).toBeUndefined();
    expect(aiLaunchRefusalOf({ code: "credential_missing" })).toBeUndefined();
    expect(aiLaunchRefusalSentence({ code: "FORBIDDEN" })).toBeUndefined();
  });

  it("says all of it as one paragraph", () => {
    expect(aiLaunchRefusalSentence({ details: { problems } })).toBe(
      aiLaunchProblemsSentence(problems),
    );
  });
});
