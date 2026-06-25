import { describe, it, expect } from "vitest";
import { buildCaseChatHandoff } from "../eval-chat-handoff";

describe("buildCaseChatHandoff", () => {
  it("builds a config-only handoff (no seeded messages) with a stable id", () => {
    const handoff = buildCaseChatHandoff({
      caseId: "case_123",
      serverNames: ["amazon", "weather"],
      modelId: "claude-opus-4-8",
      advancedConfig: {
        system: "You are a shopping assistant.",
        temperature: 0.3,
        requireToolApproval: true,
      },
    });

    // Config-only: empty thread, so no graded run is implied — Record mode
    // starts live and ungraded.
    expect(handoff.messages).toEqual([]);
    // Stable identity per case so PlaygroundMain consumes it once.
    expect(handoff.id).toBe("eval-live:case_123");
    expect(handoff.serverNames).toEqual(["amazon", "weather"]);
    expect(handoff.executionConfig).toEqual({
      modelId: "claude-opus-4-8",
      systemPrompt: "You are a shopping assistant.",
      temperature: 0.3,
      requireToolApproval: true,
    });
  });

  it("coerces non-conforming advancedConfig fields to undefined", () => {
    const handoff = buildCaseChatHandoff({
      caseId: "c",
      serverNames: [],
      advancedConfig: {
        system: 42, // not a string
        temperature: "hot", // not a number
        requireToolApproval: "yes", // not a boolean
      },
    });

    expect(handoff.executionConfig).toEqual({
      modelId: undefined,
      systemPrompt: undefined,
      temperature: undefined,
      requireToolApproval: undefined,
    });
  });

  it("tolerates a missing advancedConfig", () => {
    const handoff = buildCaseChatHandoff({
      caseId: "c",
      serverNames: ["s"],
      modelId: "m",
      advancedConfig: null,
    });
    expect(handoff.executionConfig.modelId).toBe("m");
    expect(handoff.executionConfig.systemPrompt).toBeUndefined();
  });
});
