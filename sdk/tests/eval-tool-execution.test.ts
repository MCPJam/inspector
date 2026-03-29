import {
  finalizePassedForEval,
  isCallToolResultError,
  traceIndicatesToolExecutionFailure,
  traceMessagePartIndicatesToolFailure,
} from "../src/eval-tool-execution";

describe("isCallToolResultError", () => {
  it("is true when isError is true", () => {
    expect(isCallToolResultError({ isError: true, content: [] })).toBe(true);
  });

  it("is false for success results", () => {
    expect(isCallToolResultError({ isError: false, content: [] })).toBe(false);
    expect(isCallToolResultError({ content: [] })).toBe(false);
    expect(isCallToolResultError(null)).toBe(false);
  });
});

describe("traceMessagePartIndicatesToolFailure", () => {
  it("detects tool-result with result.isError", () => {
    expect(
      traceMessagePartIndicatesToolFailure({
        type: "tool-result",
        toolCallId: "1",
        result: { isError: true, content: [{ type: "text", text: "bad" }] },
      }),
    ).toBe(true);
  });

  it("detects nested output.value.isError", () => {
    expect(
      traceMessagePartIndicatesToolFailure({
        type: "tool-result",
        output: { type: "json", value: { isError: true } },
      }),
    ).toBe(true);
  });

  it("detects error-text output", () => {
    expect(
      traceMessagePartIndicatesToolFailure({
        type: "tool-result",
        output: { type: "error-text", value: "x" },
      }),
    ).toBe(true);
  });

  it("ignores non-tool-result parts", () => {
    expect(
      traceMessagePartIndicatesToolFailure({ type: "text", text: "hi" }),
    ).toBe(false);
  });
});

describe("traceIndicatesToolExecutionFailure", () => {
  it("detects errored tool spans", () => {
    expect(
      traceIndicatesToolExecutionFailure({
        spans: [
          {
            id: "s1",
            name: "t",
            category: "tool",
            startMs: 0,
            endMs: 1,
            status: "error",
          },
        ],
      }),
    ).toBe(true);
  });

  it("ignores ok tool spans", () => {
    expect(
      traceIndicatesToolExecutionFailure({
        spans: [
          {
            id: "s1",
            name: "t",
            category: "tool",
            startMs: 0,
            endMs: 1,
            status: "ok",
          },
        ],
      }),
    ).toBe(false);
  });

  it("reads messages array trace shape", () => {
    expect(
      traceIndicatesToolExecutionFailure([
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              result: { isError: true, content: [] },
            },
          ],
        },
      ]),
    ).toBe(true);
  });
});

describe("finalizePassedForEval", () => {
  it("preserves matchPassed when gate off", () => {
    expect(
      finalizePassedForEval({
        matchPassed: true,
        trace: {
          spans: [
            {
              id: "s1",
              name: "t",
              category: "tool",
              startMs: 0,
              endMs: 1,
              status: "error",
            },
          ],
        },
        failOnToolError: false,
      }),
    ).toBe(true);
  });

  it("fails when tool error and gate on", () => {
    expect(
      finalizePassedForEval({
        matchPassed: true,
        trace: {
          spans: [
            {
              id: "s1",
              name: "t",
              category: "tool",
              startMs: 0,
              endMs: 1,
              status: "error",
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("fails on iterationError when gate on", () => {
    expect(
      finalizePassedForEval({
        matchPassed: true,
        iterationError: "boom",
      }),
    ).toBe(false);
  });

  it("ignores iterationError when gate off", () => {
    expect(
      finalizePassedForEval({
        matchPassed: true,
        iterationError: "boom",
        failOnToolError: false,
      }),
    ).toBe(true);
  });
});
