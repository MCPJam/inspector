import { describe, expect, it } from "vitest";

import {
  canonicalJudgeModelId,
  judgeModelIdSchema,
} from "../judge-model-id.js";

// CONVEX-33X: a suite file named its judge `mcpjam/anthropic/claude-haiku-4.5`,
// the spelling the SDK and CLI document for an MCPJam-hosted model, and the
// backend refused it as "not in MCPJam's hosted model catalog", which knows the
// model as `anthropic/claude-haiku-4.5`. The route tests live with the routes
// (`judge-model-from-file.test.ts`, `eval-edit.test.ts`,
// `insights-envelope.test.ts`); this file imports the helper alone.

describe("canonicalJudgeModelId", () => {
  it.each([
    ["mcpjam/anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5"],
    ["mcpjam/openai/gpt-5.4-mini", "openai/gpt-5.4-mini"],
    [" mcpjam/openai/gpt-5.4-mini ", "openai/gpt-5.4-mini"],
  ])("drops the documented hosted prefix: %j", (input, expected) => {
    expect(canonicalJudgeModelId(input)).toBe(expected);
  });

  it.each([
    ["anthropic/claude-haiku-4.5", "anthropic/claude-haiku-4.5"],
    // Trimmed even without the prefix, or the padding is stored and the judge
    // lookup misses at grading.
    ["openai/gpt-5.4-mini ", "openai/gpt-5.4-mini"],
  ])("leaves a catalog id as it is, trimmed: %j", (input, expected) => {
    expect(canonicalJudgeModelId(input)).toBe(expected);
  });

  it.each([
    // A dashed legacy alias: the save check would accept it through its alias
    // table, but grading looks the model up by exact id.
    "mcpjam/anthropic/claude-sonnet-4-6",
    // Stripping once would leave the CONVEX-33X message about an id the
    // caller did not type.
    "mcpjam/mcpjam/anthropic/claude-haiku-4.5",
    // Padding inside the id is not trimmed into a different id.
    "mcpjam/ openai/gpt-5.4-mini",
    // Case-sensitive, like every other parser of this prefix and the catalog.
    "MCPJam/anthropic/claude-haiku-4.5",
    "mcpjam/Anthropic/claude-haiku-4.5",
    // Not hosted, and malformed shapes.
    "mcpjam/xai/grok-4",
    "mcpjam/claude-haiku-4.5",
    "mcpjam//x",
  ])("passes %j through as typed, so the refusal names it", (input) => {
    expect(canonicalJudgeModelId(input)).toBe(input.trim());
  });
});

describe("judgeModelIdSchema", () => {
  it("parses to the catalog id", () => {
    expect(
      judgeModelIdSchema.parse(" mcpjam/anthropic/claude-haiku-4.5 "),
    ).toBe("anthropic/claude-haiku-4.5");
  });

  it("refuses a blank id instead of storing one", () => {
    expect(judgeModelIdSchema.safeParse("   ").success).toBe(false);
    expect(judgeModelIdSchema.safeParse("").success).toBe(false);
  });
});
