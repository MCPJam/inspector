import { describe, expect, it } from "vitest";
import { buildOwnedMrtrChatResumeBody } from "../mrtr-chat-resume";
import { parseMrtrChatResumeRequest } from "@/shared/mrtr-continuation";
describe("owned model form answer transport", () => {
  it("carries only the private receipt and exact original call identity", () => {
    const operation = {
      instanceToken: "a".repeat(43),
      toolCallId: "original",
      toolName: "review",
    };
    const body = buildOwnedMrtrChatResumeBody({
      operation,
      serverId: "server",
      continuationId: "parent",
      round: 1,
      responsesBlobId: "private",
    });
    expect(body.mrtrResume).not.toHaveProperty("responses");
    expect(parseMrtrChatResumeRequest(body.mrtrResume)?.owned).toEqual({
      ...operation,
      submission: {
        continuationId: "parent",
        round: 1,
        responsesBlobId: "private",
      },
    });
  });
  it("the server refuses a mismatched engine call id", () => {
    const operation = {
      instanceToken: "a".repeat(43),
      toolCallId: "original",
      toolName: "review",
    };
    const body = buildOwnedMrtrChatResumeBody({
      operation,
      serverId: "server",
      continuationId: "parent",
      round: 1,
      responsesBlobId: "private",
    });
    expect(
      parseMrtrChatResumeRequest({ ...body.mrtrResume, toolCallId: "other" }),
    ).toBeNull();
  });
});
