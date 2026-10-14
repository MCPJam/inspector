import { describe, expect, it } from "vitest";
import type { ModelMessage, UIMessage } from "ai";
import {
  dropEmptyTextBlocks,
  hostedMessagesWithoutEmptyText,
} from "../empty-text-blocks.js";
import { normalizeModelMessagesForConvex } from "../normalize-model-messages-for-convex.js";
import { convertToMcpjamModelMessages } from "../mcp-tool-result-model-output.js";
import { stampSenderUserIdsOnSessionMessages } from "../chat-ingestion.js";
import { appendPluginModelContext } from "@/shared/plugin-model-context";
import { preservePluginMessageTitles } from "@/shared/plugin-message-history";
import { pluginMessageParts } from "@/shared/plugin-message";

const image = {
  type: "file" as const,
  mediaType: "image/png",
  data: { type: "data" as const, data: "aGVsbG8=" },
};

describe("request cleanup preserves history and attribution", () => {
  it("keeps signed reasoning, nonempty text metadata, image-only turns, and system controls", () => {
    const reasoning = {
      type: "reasoning",
      text: "",
      providerOptions: { anthropic: { signature: "signed" } },
    };
    const text = {
      type: "text",
      text: " text ",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    };
    const messages = [
      {
        role: "system",
        content: "",
        providerOptions: { anthropic: { effort: "high" } },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "\n" }, reasoning, text],
      },
      { role: "user", content: [{ type: "text", text: "" }, image] },
    ];
    const before = structuredClone(messages);
    expect(dropEmptyTextBlocks(messages)).toEqual([
      messages[0],
      { ...messages[1], content: [reasoning, text] },
      { ...messages[2], content: [image] },
    ]);
    expect(messages).toEqual(before);
  });

  it("preserves a tool result when its entire caption is blank", () => {
    const messages = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "listSkills",
            output: { type: "content", value: [{ type: "text", text: "\n " }] },
          },
        ],
      },
    ];
    expect(dropEmptyTextBlocks(messages)).toEqual([
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tool-1",
            toolName: "listSkills",
            output: { type: "content", value: [] },
          },
        ],
      },
    ]);
    expect(messages[0].content[0].output.value).toHaveLength(1);
  });

  it("cleans hosted legacy result envelopes after normalization without changing their IDs", () => {
    const raw: ModelMessage[] = JSON.parse(
      JSON.stringify([
        { role: "user", content: "list skills" },
        {
          role: "assistant",
          content: [{ type: "tool-call", toolName: "listSkills", input: {} }],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolName: "listSkills",
              result: {
                type: "content",
                value: [{ type: "text", text: "" }, image],
              },
            },
          ],
        },
      ]),
    );
    const before = structuredClone(raw);
    const normalized = normalizeModelMessagesForConvex(raw);
    const request = hostedMessagesWithoutEmptyText(
      normalized,
      "anthropic/claude-haiku-4.5",
    );
    expect(request[2]).toMatchObject({
      role: "tool",
      content: [
        {
          toolCallId: "mcpjam-synth-0",
          output: { type: "content", value: [image] },
        },
      ],
    });
    expect(normalized[2]).toMatchObject({
      content: [{ output: { value: [{ type: "text", text: "" }, image] } }],
    });
    expect(raw).toEqual(before);
    expect(
      hostedMessagesWithoutEmptyText(
        normalized,
        "google/gemini-2.5-flash",
        "google",
      ),
    ).toBe(normalized);
  });

  it.each([
    ["anthropic/claude-haiku-4.5", "mcpjam"],
    ["native-model", "anthropic"],
    ["native-model", "bedrock"],
    ["claude-haiku-4-5", undefined],
  ])("scopes hosted cleanup to rejecting models (%s)", (id, provider) => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "\n" },
      { role: "user", content: "list skills" },
    ];
    expect(hostedMessagesWithoutEmptyText(messages, id!, provider)).toEqual([
      messages[0],
      messages[2],
    ]);
    expect(messages).toHaveLength(3);
  });

  it("preserves empty user ordinals for sender attribution and plugin titles", async () => {
    const source: UIMessage[] = [
      { id: "first", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "blank",
        role: "user",
        parts: [{ type: "text", text: "" }],
        metadata: { senderUserId: "sender-1" },
      },
      {
        id: "plugin",
        role: "user",
        parts: pluginMessageParts({
          role: "user",
          content: [
            {
              type: "text",
              text: "plugin question",
              _meta: { "openai/title": "Question" },
            },
          ],
        }),
      },
    ];
    const converted = await convertToMcpjamModelMessages(source);
    expect(converted.filter((m) => m.role === "user")).toHaveLength(3);
    const stamped = stampSenderUserIdsOnSessionMessages(converted, source, {
      authenticatedUserId: "sender-1",
    });
    expect(stamped[1]).toMatchObject({ senderUserId: "sender-1" });
    expect(stamped[2]).not.toHaveProperty("senderUserId");
    expect(preservePluginMessageTitles(converted, source)[2]).toMatchObject({
      content: [
        expect.objectContaining({
          text: "plugin question",
          mcpjamMessageTitle: "Question",
        }),
      ],
    });
  });

  it("keeps the empty user turn available for plugin model context", async () => {
    const converted = await convertToMcpjamModelMessages([
      { id: "blank", role: "user", parts: [{ type: "text", text: "" }] },
    ]);
    const context: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: "widget state" }],
    };
    expect(() => appendPluginModelContext(converted, context)).not.toThrow();
    expect(appendPluginModelContext(converted, context)[0]).toMatchObject({
      role: "user",
      content: expect.arrayContaining([{ type: "text", text: "widget state" }]),
    });
  });
});
