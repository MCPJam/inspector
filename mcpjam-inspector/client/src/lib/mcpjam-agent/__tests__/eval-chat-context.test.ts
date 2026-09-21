import { describe, expect, it } from "vitest";
import {
  compactEvalContextMessages,
  evalChatSuiteContext,
} from "../eval-chat-context";

describe("eval authoring context", () => {
  const trace = "large-tool-response".repeat(100000);
  const suite = {
    _id: "suite",
    name: "Suite",
    hostConfigSnapshot: trace,
  } as any;
  const runs = [
    { _id: "run", createdAt: 1, status: "completed", configSnapshot: trace },
  ] as any;
  const iterations = [
    {
      _id: "iteration",
      actualToolCalls: [{ response: trace }],
      messages: trace,
    },
  ] as any;
  it("keeps coverage and run identity without copying large execution payloads", () => {
    const context = evalChatSuiteContext(
      suite,
      [
        {
          _id: "case",
          title: "Pay",
          query: "Pay invoice",
          expectedToolCalls: [{ toolName: "pay" }],
        },
      ] as any,
      runs,
      iterations,
    );
    expect(context.cases[0]).toMatchObject({
      _id: "case",
      title: "Pay",
      expectedTools: ["pay"],
    });
    expect(context.runs[0]._id).toBe("run");
    expect(context.iterationCount).toBe(1);
    expect(JSON.stringify(context).length).toBeLessThan(10000);
  });
  it("compacts previously stored context outputs without mutating the transcript", () => {
    const text = JSON.stringify({
      scope: { suiteId: "suite" },
      suite: { suite, runs, iterations, cases: [] },
    });
    const messages = [
      {
        parts: [
          {
            type: "tool-ui_eval_context",
            output: { content: [{ type: "text", text }] },
          },
          { type: "text", text: "Generate cases" },
        ],
      },
    ];
    const wire = compactEvalContextMessages(messages);
    expect(JSON.stringify(wire).length).toBeLessThan(10000);
    expect(messages[0].parts[0].output?.content[0].text).toBe(text);
    expect(wire[0].parts[1]).toEqual(messages[0].parts[1]);
  });
});
