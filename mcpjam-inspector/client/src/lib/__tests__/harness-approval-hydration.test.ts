import { convertToModelMessages } from "ai";
import { describe, expect, it } from "vitest";
import { transcriptToUIMessages } from "../transcript-to-ui-messages";

const pending = [
  { approvalId: "approval-1", toolCallId: "call-1", providerExecuted: true },
];
const transcript = [
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "bash",
        input: { command: "touch example" },
      },
    ],
  },
];

describe("harness approval reload hydration", () => {
  it("restores a provider-executed pending approval through the real model conversion", async () => {
    const messages = transcriptToUIMessages(transcript, pending);
    expect(messages[0].parts[0]).toMatchObject({
      state: "approval-requested",
      providerExecuted: true,
      approval: { id: "approval-1" },
    });
    const converted = await convertToModelMessages(messages);
    expect(converted).toEqual([
      expect.objectContaining({
        role: "assistant",
        content: expect.arrayContaining([
          {
            type: "tool-approval-request",
            approvalId: "approval-1",
            toolCallId: "call-1",
          },
        ]),
      }),
    ]);
  });

  it("leaves completed calls completed even if the sidecar read was stale", () => {
    const messages = transcriptToUIMessages(
      [
        ...transcript,
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "call-1",
              toolName: "bash",
              output: { type: "text", value: "done" },
            },
          ],
        },
      ],
      pending,
    );
    expect(messages[0].parts[0]).toMatchObject({ state: "output-available" });
    expect(messages[0].parts[0]).not.toHaveProperty("approval");
  });

  it("does not invent approvals from historical tool calls or unknown ids", () => {
    for (const approvals of [
      undefined,
      [],
      [{ approvalId: "other", toolCallId: "other" }],
    ]) {
      expect(
        transcriptToUIMessages(transcript, approvals)[0].parts[0],
      ).toMatchObject({ state: "input-available" });
    }
  });

  it("preserves host-executed approval delivery", () => {
    expect(
      transcriptToUIMessages(transcript, [
        { ...pending[0], providerExecuted: false },
      ])[0].parts[0],
    ).toMatchObject({ providerExecuted: false, state: "approval-requested" });
  });
});
