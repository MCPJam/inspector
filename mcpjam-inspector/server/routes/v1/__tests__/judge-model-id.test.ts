import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  canonicalJudgeModelId,
  canonicalJudgeModelIdForSelection,
  judgeModelIdSchema,
} from "../judge-model-id.js";
import {
  __resetHostedModelCatalogForTests,
  ingestHostedCatalogIds,
} from "../../../services/hosted-model-catalog.js";

// CONVEX-33X: a suite file named its judge `mcpjam/anthropic/claude-haiku-4.5`,
// the spelling the SDK and CLI document for an MCPJam-hosted model, and the
// backend refused it as "not in MCPJam's hosted model catalog", which knows the
// model as `anthropic/claude-haiku-4.5`. The route tests live with the routes
// (`judge-model-from-file.test.ts`, `eval-edit.test.ts`,
// `insights-envelope.test.ts`); this file imports the helper alone.
//
// Made-up ids, ingested into the DYNAMIC catalog for each test: they cannot be
// retired by a snapshot regeneration, and they exercise the path a model only
// the backend's live catalog knows takes.
const HAIKU = "anthropic/judge-fixture-haiku-9.9";
const MINI = "openai/judge-fixture-mini-9.9";

beforeEach(() => {
  __resetHostedModelCatalogForTests();
  ingestHostedCatalogIds([HAIKU, MINI]);
});

afterEach(() => {
  __resetHostedModelCatalogForTests();
});

describe("canonicalJudgeModelId", () => {
  it.each([
    [`mcpjam/${HAIKU}`, HAIKU],
    [`mcpjam/${MINI}`, MINI],
    [` mcpjam/${MINI} `, MINI],
  ])("drops the documented hosted prefix: %j", (input, expected) => {
    expect(canonicalJudgeModelId(input)).toBe(expected);
  });

  it.each([
    [HAIKU, HAIKU],
    // Trimmed even without the prefix, or the padding is stored and the judge
    // lookup misses at grading.
    [`${MINI} `, MINI],
  ])("leaves a catalog id as it is, trimmed: %j", (input, expected) => {
    expect(canonicalJudgeModelId(input)).toBe(expected);
  });

  it.each([
    // A dashed spelling of a catalog id, like the backend's legacy aliases: the
    // save check would accept an alias through its table, but grading looks
    // the model up by exact id.
    "mcpjam/anthropic/judge-fixture-haiku-9-9",
    // Stripping once would leave the CONVEX-33X message about an id the
    // caller did not type.
    `mcpjam/mcpjam/${HAIKU}`,
    // Padding inside the id is not trimmed into a different id.
    `mcpjam/ ${MINI}`,
    // Case-sensitive, like every other parser of this prefix and the catalog.
    `MCPJam/${HAIKU}`,
    "mcpjam/Anthropic/judge-fixture-haiku-9.9",
    // Not hosted, and malformed shapes.
    "mcpjam/xai/judge-fixture-grok",
    "mcpjam/judge-fixture-haiku-9.9",
    "mcpjam//x",
  ])("passes %j through as typed, so the refusal names it", (input) => {
    expect(canonicalJudgeModelId(input)).toBe(input.trim());
  });

  it("forwards a model the catalog does not know yet as typed", () => {
    // The rewrite reads the Inspector's cached catalog; until it learns a new
    // model, the id is forwarded unchanged rather than guessed at.
    __resetHostedModelCatalogForTests();
    expect(canonicalJudgeModelId(`mcpjam/${HAIKU}`)).toBe(`mcpjam/${HAIKU}`);
  });
});

describe("judgeModelIdSchema", () => {
  it("parses to the catalog id", () => {
    expect(judgeModelIdSchema.parse(` mcpjam/${HAIKU} `)).toBe(HAIKU);
  });

  it("refuses a blank id instead of storing one", () => {
    expect(judgeModelIdSchema.safeParse("   ").success).toBe(false);
    expect(judgeModelIdSchema.safeParse("").success).toBe(false);
  });
});

describe("canonicalJudgeModelIdForSelection", () => {
  it("normalizes a hosted judge, or a bare id with no selection", () => {
    expect(canonicalJudgeModelIdForSelection(`mcpjam/${HAIKU}`)).toBe(HAIKU);
    expect(
      canonicalJudgeModelIdForSelection(`mcpjam/${HAIKU}`, {
        source: "hosted",
      }),
    ).toBe(HAIKU);
  });

  it("never rewrites an organization (BYOK) judge — judges are not hosted-only", () => {
    expect(
      canonicalJudgeModelIdForSelection(` ${HAIKU} `, { source: "org" }),
    ).toBe(HAIKU);
    // Left as sent, so the selection mismatch check names the contradiction.
    expect(
      canonicalJudgeModelIdForSelection(`mcpjam/${HAIKU}`, { source: "org" }),
    ).toBe(`mcpjam/${HAIKU}`);
  });
});
