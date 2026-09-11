import { expect, it } from "vitest";
import type { UIMessage } from "ai";
import { describeTranscript } from "../describe-transcript";

it.each(["tool-ui_eval_generate_cases", "dynamic-tool"])(
  "hides legacy approval cards encoded as %s without changing the transport history",
  (type) => {
    const messages = [
      {
        id: "legacy",
        role: "assistant",
        parts: [
          { type: "text", text: "Run ui_eval_generate_cases" },
          {
            type,
            toolName: "ui_eval_generate_cases",
            toolCallId: "call",
            state: "approval-requested",
            input: { instructions: "Search issues" },
            approval: { id: "approval" },
          },
        ],
      },
    ] as UIMessage[];
    const original = structuredClone(messages);
    expect(describeTranscript(messages)).toEqual([]);
    expect(messages).toEqual(original);
  },
);
it("keeps the user's request and short redirects but hides protocol tool details", () => {
  const messages = [
    {
      id: "u",
      role: "user",
      parts: [{ type: "text", text: "Test issue search" }],
    },
    {
      id: "context",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "ui_eval_context",
          toolCallId: "c",
          state: "output-available",
          input: {},
          output: {},
        },
      ],
    },
    {
      id: "redirect",
      role: "assistant",
      parts: [{ type: "text", text: "Describe a behavior you want to test." }],
    },
  ] as UIMessage[];
  expect(describeTranscript(messages).map((m) => m.id)).toEqual([
    "u",
    "redirect",
  ]);
});
