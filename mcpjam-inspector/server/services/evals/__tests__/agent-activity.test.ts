/**
 * The guard against a trial that passes having run nothing.
 *
 * Both directions are load-bearing and the EXEMPTIONS are the harder half: a
 * false positive here fails a run that was perfectly fine, where a false
 * negative merely leaves the status quo. So every case below that does NOT
 * fire is a case somebody would otherwise have had to debug.
 */
import { describe, expect, it } from "vitest";
import { assessAgentActivity, countModelInvocations } from "../agent-activity";

const base = {
  modelFree: false,
  isNegativeTest: false,
  expectedToolCalls: 2,
  toolSurface: { mcpTools: 5, browserTools: false },
  toolCalls: 0,
  modelInvocations: 0,
};

describe("assessAgentActivity", () => {
  it("fires when a tool-expecting case had no tool calls and no model runs", () => {
    // The matcher is satisfied when every EXPECTED call was made and none was
    // forbidden — and a model that never ran made no forbidden call either. On
    // a case whose predicates read an empty transcript, "nothing happened" and
    // "it behaved perfectly" are the same verdict.
    const result = assessAgentActivity(base);
    expect(result.status).toBe("no_agent_activity");
    expect(result).toHaveProperty("detail");
    if (result.status === "no_agent_activity") {
      expect(result.detail).toContain("2 tool call(s)");
    }
  });

  it("fires for a browser case that expected no named tool calls", () => {
    // A browser case's work is in the browser, not in an `expectedToolCalls`
    // list. Requiring named expectations would exempt exactly the surface most
    // able to fail silently — a box that never provisioned.
    expect(
      assessAgentActivity({
        ...base,
        expectedToolCalls: 0,
        toolSurface: { mcpTools: 0, browserTools: true },
      }).status,
    ).toBe("no_agent_activity");
  });

  it("is exempt for a model-free case", () => {
    // THE EXEMPTION THAT MATTERS MOST. A pinned-step case is SUPPOSED to have
    // zero model invocations, so a guard that did not know about them would
    // fail every widget probe in the suite.
    expect(assessAgentActivity({ ...base, modelFree: true })).toEqual({
      status: "exempt",
      reason: "model_free",
    });
  });

  it("is exempt for a negative test", () => {
    // "It did nothing" is a plausible CORRECT answer for a negative case. The
    // guard cannot tell a model that properly declined from one that never
    // ran, and failing the first is worse than missing the second.
    expect(assessAgentActivity({ ...base, isNegativeTest: true })).toEqual({
      status: "exempt",
      reason: "negative_test",
    });
  });

  it("is exempt when the case expects no tools and has no browser policy", () => {
    // A pure-conversation case legitimately calls nothing.
    expect(
      assessAgentActivity({ ...base, expectedToolCalls: 0 }),
    ).toEqual({ status: "exempt", reason: "no_tool_expected" });
  });

  it("distinguishes a case with no tools ADVERTISED from one that expected none", () => {
    // Both are exempt; they are different findings for whoever reads the
    // metadata asking why the guard never fires.
    expect(
      assessAgentActivity({
        ...base,
        expectedToolCalls: 0,
        toolSurface: { mcpTools: 0, browserTools: false },
      }),
    ).toEqual({ status: "exempt", reason: "no_tool_surface" });
  });

  it("is ACTIVE when the model ran but chose no tool", () => {
    // A real answer, and often the right one. Failing it would make the guard
    // a check on model quality, which it is not.
    expect(
      assessAgentActivity({ ...base, modelInvocations: 1 }),
    ).toEqual({ status: "active" });
  });

  it("is ACTIVE when a tool was called but no model span was recorded", () => {
    // Either is enough. An executor that reports tool calls and no spans has
    // demonstrably run something.
    expect(assessAgentActivity({ ...base, toolCalls: 1 })).toEqual({
      status: "active",
    });
  });
});

describe("countModelInvocations", () => {
  it("counts llm spans when the trace has any", () => {
    expect(
      countModelInvocations({
        spans: [
          { category: "llm" },
          { category: "tool" },
          { category: "llm" },
        ],
      }),
    ).toBe(2);
  });

  it("falls back to assistant messages when there is NO span channel", () => {
    // Load-bearing: a caller-supplied `HostExecutor` reports a transcript and
    // no spans at all. Counting only spans would read every one of its runs as
    // "nothing happened" — turning a guard against vacuous passes into a
    // generator of false failures on the surface most prone to the problem.
    expect(
      countModelInvocations({
        messages: [
          { role: "user" },
          { role: "assistant" },
          { role: "assistant" },
        ],
      }),
    ).toBe(2);
  });

  it("prefers spans over messages when both exist", () => {
    // Spans are the direct record. A transcript can carry assistant turns a
    // harness synthesised.
    expect(
      countModelInvocations({
        spans: [{ category: "tool" }],
        messages: [{ role: "assistant" }, { role: "assistant" }],
      }),
    ).toBe(0);
  });

  it("answers zero for a trace with neither", () => {
    expect(countModelInvocations({})).toBe(0);
    expect(countModelInvocations({ spans: [], messages: [] })).toBe(0);
  });
});
