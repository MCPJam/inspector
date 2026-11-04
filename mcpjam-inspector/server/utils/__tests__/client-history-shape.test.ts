import { describe, expect, it } from "vitest";
import { findMalformedHistory } from "../client-history-shape";
import { convertToMcpjamModelMessages } from "../mcp-tool-result-model-output";

const user = (parts: unknown) => ({ id: "u", role: "user", parts });
const assistant = (parts: unknown) => ({ id: "a", role: "assistant", parts });
const text = { type: "text", text: "hi" };
const png = "data:image/png;base64,iVBORw0KGgo=";
const mention = {
  type: "data-plugin-mention",
  data: {
    serverId: "owned",
    toolName: "mentions",
    item: { type: "resource_link", uri: "fixture://bolt", name: "Bolt" },
  },
};
const pluginText = {
  type: "data-plugin-message-text",
  data: { title: "Draft", text: "hi" },
};

describe("findMalformedHistory", () => {
  it.each([
    {
      name: "a message from before UI parts",
      messages: [{ id: "u", role: "user", content: "hi" }],
      expected: { messageIndex: 0, problem: "parts_missing" },
    },
    {
      name: "a non-object message",
      messages: [user([text]), null],
      expected: { messageIndex: 1, problem: "message_not_object" },
    },
    {
      name: "a null part",
      messages: [user([null, text])],
      expected: { messageIndex: 0, partIndex: 0, problem: "part_not_object" },
    },
    {
      name: "a part without a type",
      messages: [user([text, { text: "hi" }])],
      expected: { messageIndex: 0, partIndex: 1, problem: "part_type_missing" },
    },
    {
      name: "a file part with a relative url",
      messages: [
        user([{ type: "file", mediaType: "image/png", url: "/a.png" }]),
      ],
      expected: { messageIndex: 0, partIndex: 0, problem: "file_url_invalid" },
    },
    {
      name: "a file part with no url",
      messages: [user([{ type: "file", mediaType: "image/png" }])],
      expected: { messageIndex: 0, partIndex: 0, problem: "file_url_invalid" },
    },
    {
      name: "an assistant reasoning file with raw base64",
      messages: [
        user([text]),
        assistant([
          { type: "reasoning-file", mediaType: "image/png", url: "iVBORw0K" },
        ]),
      ],
      expected: { messageIndex: 1, partIndex: 0, problem: "file_url_invalid" },
    },
  ])(
    "names $name, which conversion cannot read",
    async ({ messages, expected }) => {
      expect(findMalformedHistory(messages)).toEqual(expected);
      await expect(
        convertToMcpjamModelMessages(messages as never),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it.each([
    {
      name: "a plugin mention without data",
      messages: [user([text, { type: "data-plugin-mention" }])],
      expected: {
        messageIndex: 0,
        partIndex: 1,
        problem: "plugin_data_invalid",
      },
    },
    {
      name: "a plugin message text without a title",
      messages: [
        user([{ type: "data-plugin-message-text", data: { text: "hi" } }]),
      ],
      expected: {
        messageIndex: 0,
        partIndex: 0,
        problem: "plugin_data_invalid",
      },
    },
  ])(
    "names $name, which conversion refuses to drop",
    async ({ messages, expected }) => {
      expect(findMalformedHistory(messages)).toEqual(expected);
      await expect(
        convertToMcpjamModelMessages(messages as never),
      ).rejects.toThrow();
    },
  );

  it("accepts a history conversion can read", async () => {
    const messages = [
      user([text, { type: "file", mediaType: "image/png", url: png }]),
      assistant([
        text,
        {
          type: "dynamic-tool",
          toolName: "list",
          toolCallId: "c1",
          state: "output-available",
          input: {},
          output: { content: [] },
        },
        { type: "data-unknown", data: { anything: true } },
        { type: "constructor" },
      ]),
      user([
        text,
        mention,
        pluginText,
        {
          type: "file",
          mediaType: "application/pdf",
          url: "not a url",
          providerReference: { kind: "stored", id: "f1" },
        },
      ]),
    ];

    expect(findMalformedHistory(messages)).toBeNull();
    await expect(
      convertToMcpjamModelMessages(messages as never),
    ).resolves.toBeInstanceOf(Array);
  });
});
