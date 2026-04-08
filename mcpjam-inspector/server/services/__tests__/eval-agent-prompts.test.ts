import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT as EVAL_AGENT_SYSTEM_PROMPT } from "../eval-agent.js";
import { AGENT_SYSTEM_PROMPT as NEGATIVE_TEST_AGENT_SYSTEM_PROMPT } from "../negative-test-agent.js";

describe("eval prompt policy", () => {
  it("keeps normal test generation attributable and discovery-backed", () => {
    expect(EVAL_AGENT_SYSTEM_PROMPT).toContain(
      "Do not write long tests that rely on fake names, ids, places, premium-only assumptions, or other unestablished workspace fixtures",
    );
    expect(EVAL_AGENT_SYSTEM_PROMPT).toContain(
      "Prefer shorter tests that first resolve the live entity they act on",
    );
    expect(EVAL_AGENT_SYSTEM_PROMPT).toContain(
      "If the capability naturally requires a recurring discovery or bootstrap pattern, keep that stable sequence in expectedToolCalls",
    );
    expect(EVAL_AGENT_SYSTEM_PROMPT).toContain(
      "replace it with a substantially different but still relevant case",
    );
    expect(EVAL_AGENT_SYSTEM_PROMPT).toContain(
      "At least 2 normal tests must use promptTurns with 2-3 user turns",
    );
    expect(EVAL_AGENT_SYSTEM_PROMPT).toContain(
      "the first turn should already trigger at least one tool",
    );
  });

  it("keeps negative test generation short and clearly no-tool", () => {
    expect(NEGATIVE_TEST_AGENT_SYSTEM_PROMPT).toContain(
      "The tool list is authoring context only. Every generated case must still expect no tools.",
    );
    expect(NEGATIVE_TEST_AGENT_SYSTEM_PROMPT).toContain(
      "Prefer short, clearly non-actionable prompts over long synthetic workflows",
    );
    expect(NEGATIVE_TEST_AGENT_SYSTEM_PROMPT).toContain(
      "Do not make a case negative merely because it depends on fake workspace entities",
    );
  });
});
