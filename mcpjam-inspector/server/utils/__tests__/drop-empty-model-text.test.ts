import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, type ModelMessage, type UIMessage } from "ai";
import { describe, expect, it, vi } from "vitest";
import { dropEmptyModelText } from "../drop-empty-model-text.js";
import { convertToMcpjamModelMessages } from "../mcp-tool-result-model-output.js";
import { normalizeModelMessagesForConvex } from "../normalize-model-messages-for-convex.js";

const listSkillsCall = {
  type: "tool-call" as const,
  toolCallId: "skills-1",
  toolName: "listSkills",
  input: {},
};
const listSkillsResult: ModelMessage = {
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId: "skills-1",
      toolName: "listSkills",
      output: { type: "json", value: { skills: [] } },
    },
  ],
};

describe("dropEmptyModelText", () => {
  it("drops empty string messages from every text role", () => {
    const question: ModelMessage = { role: "user", content: "list skills" };
    expect(
      dropEmptyModelText([
        { role: "system", content: "" },
        { role: "user", content: "" },
        { role: "assistant", content: "" },
        question,
      ]),
    ).toEqual([question]);
  });

  it.each(["user", "assistant"] as const)(
    "drops an empty %s text block or content array",
    (role) => {
      expect(
        dropEmptyModelText([
          { role, content: [{ type: "text", text: "" }] },
          { role, content: [] },
        ]),
      ).toEqual([]);
    },
  );

  it("keeps tool calls, reasoning signatures and results beside empty text", () => {
    const reasoning = {
      type: "reasoning" as const,
      text: "",
      providerOptions: { anthropic: { signature: "signed-reasoning" } },
    };
    const assistant: ModelMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }, reasoning, listSkillsCall],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    expect(dropEmptyModelText([assistant, listSkillsResult])).toEqual([
      { ...assistant, content: [reasoning, listSkillsCall] },
      listSkillsResult,
    ]);
  });

  it("keeps an image-only user message after removing its empty text", () => {
    const image = {
      type: "image" as const,
      image: "aGVsbG8=",
      mediaType: "image/png",
    };
    expect(
      dropEmptyModelText([
        { role: "user", content: [{ type: "text", text: "" }, image] },
      ]),
    ).toEqual([{ role: "user", content: [image] }]);
  });

  it("keeps a tool result when its only text output is empty", () => {
    const message: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "skills-1",
          toolName: "listSkills",
          output: { type: "content", value: [{ type: "text", text: "" }] },
        },
      ],
    };
    expect(dropEmptyModelText([message])).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "skills-1",
            toolName: "listSkills",
            output: { type: "content", value: [] },
          },
        ],
      },
    ]);
    expect(message.content[0]).toMatchObject({
      output: { value: [{ type: "text", text: "" }] },
    });
  });

  it("preserves non-empty text and its provider options without mutating input", () => {
    const part = {
      type: "text" as const,
      text: "  list skills  ",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    const message: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "" }, part],
    };
    expect(dropEmptyModelText([message])).toEqual([
      { role: "user", content: [part] },
    ]);
    expect(message.content).toHaveLength(2);
  });

  it("keeps unchanged messages by reference and is safe to run twice", () => {
    const message: ModelMessage = { role: "user", content: "list skills" };
    const once = dropEmptyModelText([message, listSkillsResult]);
    expect(once[0]).toBe(message);
    expect(once[1]).toBe(listSkillsResult);
    expect(dropEmptyModelText(once)).toEqual(once);
  });

  it("leaves malformed history content for the existing schema validation", () => {
    const malformed: ModelMessage[] = JSON.parse(
      '[{"role":"assistant","content":null},{"role":"user"}]',
    );
    expect(dropEmptyModelText(malformed)).toEqual(malformed);
  });
});

describe("chat requests sent to Anthropic", () => {
  function capturingProvider() {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        id: "message-1",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5",
        content: [{ type: "text", text: "Listed skills." }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    );
    return {
      fetch,
      model: createAnthropic({ apiKey: "test-only", fetch })(
        "claude-haiku-4-5",
      ),
    };
  }

  function requestMessages(
    fetch: ReturnType<typeof capturingProvider>["fetch"],
  ) {
    const body = fetch.mock.calls[0]?.[1]?.body;
    expect(typeof body).toBe("string");
    return JSON.parse(String(body)).messages as Array<{
      role: string;
      content: Array<{ type: string; text?: string }>;
    }>;
  }

  it("removes an empty composer message on the direct-provider conversion path", async () => {
    const uiMessages: UIMessage[] = [
      {
        id: "skill",
        role: "user",
        parts: [{ type: "text", text: "list skills" }],
      },
      { id: "composer", role: "user", parts: [{ type: "text", text: "" }] },
    ];
    const messages = await convertToMcpjamModelMessages(uiMessages);
    const { model, fetch } = capturingProvider();
    await generateText({ model, messages, maxRetries: 0 });
    expect(requestMessages(fetch)).toEqual([
      { role: "user", content: [{ type: "text", text: "list skills" }] },
    ]);
  });

  it("removes an empty assistant placeholder on the hosted path", async () => {
    const messages = normalizeModelMessagesForConvex([
      { role: "user", content: "hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "list skills" },
    ]);
    const { model, fetch } = capturingProvider();
    await generateText({ model, messages, maxRetries: 0 });
    expect(requestMessages(fetch)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          { type: "text", text: "list skills" },
        ],
      },
    ]);
  });

  it("preserves the list-skills tool round trip on the hosted path", async () => {
    const messages = normalizeModelMessagesForConvex([
      { role: "user", content: "list skills" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }, listSkillsCall],
      },
      listSkillsResult,
    ]);
    const { model, fetch } = capturingProvider();
    await generateText({ model, messages, maxRetries: 0 });
    const request = requestMessages(fetch);
    expect(request.flatMap((message) => message.content)).not.toContainEqual({
      type: "text",
      text: "",
    });
    expect(request[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "tool_use", id: "skills-1", name: "listSkills", input: {} },
      ],
    });
    expect(request[2]).toMatchObject({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "skills-1" }],
    });
  });

  it("removes empty tool text after converting MCP images for a direct provider", async () => {
    const messages = await convertToMcpjamModelMessages([
      {
        id: "question",
        role: "user",
        parts: [{ type: "text", text: "list skills" }],
      },
      {
        id: "reply",
        role: "assistant",
        parts: [
          {
            type: "tool-listSkills",
            toolCallId: "skills-1",
            state: "output-available",
            input: {},
            output: {
              content: [
                { type: "text", text: "" },
                { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
              ],
            },
          },
        ],
      },
    ]);
    const { model, fetch } = capturingProvider();
    await generateText({ model, messages, maxRetries: 0 });
    expect(requestMessages(fetch)[2]).toMatchObject({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "skills-1",
          content: [{ type: "image" }],
        },
      ],
    });
  });
});
