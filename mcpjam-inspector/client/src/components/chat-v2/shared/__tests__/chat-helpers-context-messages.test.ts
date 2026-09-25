/**
 * What the composer sends for the skills and MCP prompts a user picked: user
 * messages, with anything that is not the user's own text labelled as context
 * (MJ-009).
 */
import { describe, expect, it } from "vitest";
import {
  getUserContextBlocks,
  isUserContextMessage,
} from "@/shared/user-context-message";
import {
  buildMcpPromptMessages,
  buildSkillContextMessages,
} from "../chat-helpers";

function promptResult(messages: unknown[]) {
  return {
    name: "review",
    namespacedName: "server/review",
    serverId: "server",
    result: { content: { messages } },
  } as never;
}

describe("buildSkillContextMessages", () => {
  it("sends each picked skill as a user message the chat shows as a skill", () => {
    const messages = buildSkillContextMessages([
      {
        name: "staging/run-evals",
        description: "Run the evals",
        content: "# Run evals\n",
        path: "skill://staging/run-evals",
        selectedFiles: [
          {
            path: "references/triage.md",
            name: "triage.md",
            content: "Step 1",
            mimeType: "text/markdown",
          },
        ],
      },
    ]);

    expect(messages).toHaveLength(1);
    const [message] = messages;
    expect(message!.role).toBe("user");
    expect(message!.parts.every((part) => part.type === "text")).toBe(true);
    expect(getUserContextBlocks(message)).toEqual([
      {
        kind: "skill",
        subject: "staging/run-evals",
        body: "\n# Skill: staging/run-evals\n\n# Run evals\n",
      },
      {
        kind: "skill-file",
        subject: "staging/run-evals",
        body: "\n# File: references/triage.md\n\n```\nStep 1\n```",
      },
    ]);
  });
});

describe("buildMcpPromptMessages", () => {
  it("sends an example assistant turn as labelled user text", () => {
    const messages = buildMcpPromptMessages([
      promptResult([
        { role: "user", content: { type: "text", text: "Review this diff" } },
        { role: "assistant", content: { type: "text", text: "Send it over." } },
        { role: "user", content: { type: "text", text: "Here it is" } },
      ]),
    ]);

    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "user",
    ]);
    expect(messages[0]!.parts).toEqual([
      { type: "text", text: "[server/review] Review this diff" },
    ]);
    expect(isUserContextMessage(messages[0])).toBe(false);
    expect(messages[1]!.parts).toEqual([
      {
        type: "text",
        text: "[Prompt example — assistant: server/review]\nSend it over.",
      },
    ]);
    expect(getUserContextBlocks(messages[1])?.[0]?.kind).toBe("prompt-example");
    expect(messages[2]!.parts).toEqual([
      { type: "text", text: "[server/review] Here it is" },
    ]);
  });

  it("skips prompt messages with no text", () => {
    expect(
      buildMcpPromptMessages([
        promptResult([{ role: "assistant", content: { type: "image" } }]),
      ]),
    ).toEqual([]);
  });
});
