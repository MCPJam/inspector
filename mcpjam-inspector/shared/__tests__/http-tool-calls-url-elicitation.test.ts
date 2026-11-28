import { describe, expect, it } from "vitest";
import { executeToolCallsFromMessages } from "../http-tool-calls";
import {
  markUrlElicitationShown,
  URL_ELICITATION_NOT_SHOWN_MESSAGE,
  URL_ELICITATION_SHOWN_MESSAGE,
} from "../url-elicitation-notice";

function urlElicitationError(): Error {
  return Object.assign(new Error("URL elicitation required"), {
    code: -32042,
    data: {
      elicitations: [
        { url: "https://example.com/connect", elicitationId: "e1" },
      ],
    },
  });
}

async function modelText(error: Error): Promise<unknown> {
  const tools = {
    connect: {
      _serverId: "srv",
      execute: async () => {
        throw error;
      },
    },
  };
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "a", toolName: "connect", input: {} },
      ],
    },
  ] as any;
  const results = await executeToolCallsFromMessages(messages, {
    tools: tools as any,
  });
  return (results[0] as any).content[0].output;
}

describe("executeToolCallsFromMessages, -32042 URL elicitation", () => {
  it("tells the model nobody saw the link when no one was shown it", async () => {
    // Evals, goal runs, event turns: nothing surfaces the link.
    expect(await modelText(urlElicitationError())).toEqual({
      type: "error-text",
      value: URL_ELICITATION_NOT_SHOWN_MESSAGE,
    });
  });

  it("tells the model the user saw the link once a chat stream showed it", async () => {
    const error = urlElicitationError();
    markUrlElicitationShown(error);
    expect(await modelText(error)).toEqual({
      type: "error-text",
      value: URL_ELICITATION_SHOWN_MESSAGE,
    });
  });
});
