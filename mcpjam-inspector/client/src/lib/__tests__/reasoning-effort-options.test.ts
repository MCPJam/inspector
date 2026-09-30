import { describe, expect, it } from "vitest";
import { reasoningEffortOptions } from "../reasoning-effort-options";

describe("reasoningEffortOptions", () => {
  it("a hosted row offers exactly the catalog's list", () => {
    expect(
      reasoningEffortOptions(
        {
          id: "openai/gpt-5",
          provider: "openai",
          supportedReasoningEfforts: ["low", "high"],
        },
        "hosted",
      ),
    ).toEqual(["low", "high"]);
  });

  it("a hosted row with no catalog answer offers nothing", () => {
    expect(
      reasoningEffortOptions({ id: "openai/gpt-5", provider: "openai" }, "hosted"),
    ).toEqual([]);
  });

  it("a direct row reads the per-model provider table", () => {
    expect(
      reasoningEffortOptions(
        { id: "gpt-5.1", provider: "openai" },
        "direct",
      ),
    ).toEqual(["none", "low", "medium", "high"]);
    expect(
      reasoningEffortOptions({ id: "llama3", provider: "ollama" }, "direct"),
    ).toEqual([]);
  });

  it("an unresolved org route offers nothing; org-cloud reads the tables; harnesses use adapter rows", () => {
    const row = { id: "gpt-5.1", provider: "openai" as const };
    expect(reasoningEffortOptions(row, "org")).toEqual([]);
    expect(reasoningEffortOptions(row, "orgCloud")).toEqual([
      "none",
      "low",
      "medium",
      "high",
    ]);
    expect(reasoningEffortOptions(row, "hosted", "codex")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(reasoningEffortOptions(row, "hosted", "claude-code")).toEqual([]);
  });
});
