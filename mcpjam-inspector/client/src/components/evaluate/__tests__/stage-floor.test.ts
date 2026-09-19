import { describe, expect, it } from "vitest";
import { stageFloor, toolErrorMessage } from "../case-scorecard/stage-floor";
import type { EvalRunDecisionChain } from "@mcpjam/sdk/contract";

const chain = (reason: string, state = "failed"): EvalRunDecisionChain =>
  ({
    status: "verified",
    stages: [
      { stage: "connection", state: "passed" },
      { stage: "discovery", state: "passed" },
      { stage: "selection", state: "passed" },
      { stage: "call", state: "passed" },
      { stage: "response", state, reason },
      { stage: "userValue", state: "failed", reason: "predicateFailed" },
    ],
  }) as unknown as EvalRunDecisionChain;

const toolResult = (
  toolCallId: string,
  toolName: string,
  result: unknown,
  output?: unknown,
) => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      ...(output === undefined ? {} : { output }),
      ...(result === undefined ? {} : { result }),
    },
  ],
});

const errorResult = (text: string) => ({
  isError: true,
  content: [{ type: "text", text }],
});

describe("stageFloor", () => {
  it("quotes what the server said, and names the tool that said it", () => {
    const floor = stageFloor("response", chain("toolError"), {
      messages: [
        toolResult(
          "call-1",
          "create_journey",
          errorResult(
            "VALIDATION_ERROR: A journey must target at least one host",
          ),
        ),
      ],
    });
    expect(floor?.toolName).toBe("create_journey");
    expect(floor?.actual).toBe(
      "`create_journey` returned an error: VALIDATION_ERROR: A journey must target at least one host",
    );
  });

  it("prefers the call the chain blamed over the first one recorded", () => {
    const floor = stageFloor("response", chain("toolError"), {
      messages: [
        toolResult("call-1", "search", errorResult("Rate limited")),
        toolResult("call-2", "create_journey", errorResult("Missing host")),
      ],
      spans: [
        { id: "s1", status: "error", toolCallId: "call-2" },
        { id: "s2", status: "ok", toolCallId: "call-1" },
      ],
    });
    expect(floor?.actual).toBe(
      "`create_journey` returned an error: Missing host 1 other tool call also returned an error.",
    );
  });

  it("counts the rest without pretending to explain them", () => {
    const floor = stageFloor("response", chain("toolError"), {
      messages: [
        toolResult("a", "one", errorResult("first")),
        toolResult("b", "two", errorResult("second")),
        toolResult("c", "three", errorResult("third")),
      ],
    });
    expect(floor?.actual).toContain(
      "2 other tool calls also returned an error.",
    );
  });

  it("stays silent where it has nothing recorded to quote", () => {
    // A stage that passed, a reason it cannot speak for, a trace with no
    // error, and a shape it does not recognise: the chain's own reason label
    // is what the page shows in each of these.
    expect(stageFloor("response", chain("toolError", "passed"), {})).toBeNull();
    expect(
      stageFloor("response", chain("missingToolCall"), {
        messages: [toolResult("a", "one", errorResult("boom"))],
      }),
    ).toBeNull();
    expect(
      stageFloor("response", chain("toolError"), {
        messages: [toolResult("a", "one", { isError: false })],
      }),
    ).toBeNull();
    expect(
      stageFloor("response", chain("toolError"), {
        messages: "not an array",
        spans: 42,
      }),
    ).toBeNull();
    expect(stageFloor("response", null, undefined)).toBeNull();
  });

  it("reads an errored call that never returned a result", () => {
    const floor = stageFloor("response", chain("toolError"), {
      messages: [
        toolResult("a", "save_project_servers", undefined, {
          type: "error-text",
          value: "Connection closed",
        }),
      ],
    });
    expect(floor?.actual).toBe(
      "`save_project_servers` returned an error: Connection closed",
    );
  });
});

describe("toolErrorMessage", () => {
  it("reads the shapes MCP and the AI SDK actually record", () => {
    expect(
      toolErrorMessage({ content: [{ type: "text", text: " hi " }] }),
    ).toBe("hi");
    expect(toolErrorMessage({ type: "error-text", value: "boom" })).toBe(
      "boom",
    );
    expect(toolErrorMessage({ error: { message: "nested" } })).toBe("nested");
    expect(toolErrorMessage("plain")).toBe("plain");
    expect(toolErrorMessage({ nothing: true })).toBeUndefined();
  });

  it("collapses whitespace and caps the quote", () => {
    expect(toolErrorMessage("a\n\n  b")).toBe("a b");
    expect(toolErrorMessage("x".repeat(900))?.length).toBe(400);
  });

  it("survives a cycle rather than hanging the page", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.result = cyclic;
    expect(toolErrorMessage(cyclic)).toBeUndefined();
  });
});
