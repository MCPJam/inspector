import { describe, expect, it } from "vitest";
import {
  parsePluginMessage,
  pluginMessageDraft,
  pluginMessageDraftIntentSchema,
  pluginMessageIntentSchema,
  pluginMessageParts,
  pluginMessageSendMode,
} from "../plugin-message";

const params = {
  role: "user" as const,
  content: [
    {
      type: "text",
      text: "First",
      _meta: { "openai/title": "Card", secret: "presentation" },
    },
    { type: "image", mimeType: "image/png", data: "AQID" },
    { type: "text", text: "Last" },
  ],
  _meta: {
    "openai/message": { target: "new" as const },
    progressToken: "request",
  },
};
describe("complete app message admission and encoding", () => {
  it("preserves the complete wire envelope but strips presentation and request metadata from ordered model parts", () => {
    expect(parsePluginMessage(params)).toEqual(params);
    const copy = parsePluginMessage(params);
    expect(copy).not.toBe(params);
    expect(pluginMessageParts(params)).toEqual([
      {
        type: "data-plugin-message-text",
        data: { title: "Card", text: "First" },
      },
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,AQID",
      },
      { type: "text", text: "Last" },
    ]);
    expect(JSON.stringify(pluginMessageParts(params))).not.toContain(
      "presentation",
    );
    expect(pluginMessageSendMode(copy)).toEqual({ target: "new", send: true });
    expect(pluginMessageSendMode({ ...copy, _meta: undefined })).toEqual({
      target: "active",
      send: true,
    });
    expect(
      pluginMessageSendMode(
        parsePluginMessage({
          ...params,
          _meta: { "openai/message": { send: false } },
        }),
      ),
    ).toEqual({ target: "active", send: false });
  });
  it("shares the context codec for supplied embedded text and image resources", () => {
    const value = {
      ...params,
      content: [
        {
          type: "resource",
          resource: { uri: "file:///private/synthetic", text: "embedded text" },
        },
        {
          type: "resource",
          resource: {
            uri: "https://example.invalid/not-fetched",
            mimeType: "image/png",
            blob: "AQID",
          },
        },
      ],
    };
    expect(parsePluginMessage(value)).toEqual(value);
    expect(pluginMessageParts(value)).toEqual([
      { type: "text", text: "embedded text" },
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,AQID",
      },
    ]);
  });
  it("delivers ordered resource link metadata as inert reference text without copying private metadata", () => {
    const reference = {
      type: "resource_link",
      uri: "file:///synthetic/reference",
      name: "Note π",
      _meta: { secret: "private-reference" },
      icons: [{ src: "https://example.invalid/no-read" }],
    };
    const value = {
      ...params,
      content: [
        { type: "text", text: "before" },
        reference,
        { type: "text", text: "after" },
      ],
    };
    expect(parsePluginMessage(value).content[1]).toEqual(reference);
    const parts = pluginMessageParts(value);
    expect(parts[0]).toEqual({ type: "text", text: "before" });
    expect(parts[2]).toEqual({ type: "text", text: "after" });
    expect(JSON.stringify(parts[1])).toContain("file:///synthetic/reference");
    expect(JSON.stringify(parts[1])).toContain("does not grant access");
    expect(JSON.stringify(parts)).not.toMatch(
      /private-reference|no-read|icons/,
    );
  });
  it.each([
    { ...params, role: "assistant" },
    { ...params, content: [] },
    { ...params, _meta: { "openai/message": { target: "third" } } },
    {
      ...params,
      content: [
        ...params.content,
        { type: "audio", mimeType: "audio/wav", data: "AQID" },
      ],
    },
    {
      ...params,
      content: [{ type: "resource_link", uri: "file:///private/test" }],
    },
    {
      ...params,
      content: [
        {
          type: "resource",
          resource: {
            uri: "fixture://test",
            blob: "AAAA",
            mimeType: "application/pdf",
          },
        },
      ],
    },
    {
      ...params,
      content: [{ type: "image", mimeType: "image/png", data: "not base64!" }],
    },
    {
      ...params,
      content: [{ type: "image", mimeType: "image/svg+xml", data: "AQID" }],
    },
    {
      ...params,
      content: [
        {
          type: "resource",
          resource: {
            uri: "fixture://x",
            text: "text",
            blob: "AAAA",
            mimeType: "image/png",
          },
        },
      ],
    },
    { ...params, content: [{ type: "text", text: "a".repeat(256 * 1024) }] },
    { ...params, content: Array.from({ length: 65 }, () => params.content[0]) },
  ])("rejects the whole unsupported/malformed/oversized input", (value) => {
    expect(() => parsePluginMessage(value)).toThrow();
    expect(() => pluginMessageParts(value)).toThrow();
  });
  it("confines the lease to the private input shape", () => {
    const intent = {
      instanceToken: "x".repeat(43),
      operationId: crypto.randomUUID(),
      sourceThreadId: "old",
      params,
    };
    expect(pluginMessageIntentSchema.parse(intent)).toEqual(intent);
    expect(() =>
      pluginMessageIntentSchema.parse({ ...intent, hostId: "forged" }),
    ).toThrow();
    expect(
      pluginMessageIntentSchema.safeParse({
        ...intent,
        params: {
          ...params,
          content: [
            {
              type: "resource",
              resource: {
                uri: "fixture://x",
                text: "text",
                blob: "AAAA",
                mimeType: "image/png",
              },
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});

const draftParams = (
  content: unknown[],
  target: "active" | "new" = "active",
) => ({
  role: "user" as const,
  content,
  _meta: { "openai/message": { target, send: false } },
});

describe("editable drafts (send: false)", () => {
  it("never lets a draft reach the send path, or a send reach the draft path", () => {
    const intent = {
      instanceToken: "x".repeat(43),
      operationId: crypto.randomUUID(),
      sourceThreadId: "old",
    };
    const draft = {
      ...intent,
      params: draftParams([{ type: "text", text: "Hi" }]),
    };
    expect(pluginMessageIntentSchema.safeParse(draft).success).toBe(false);
    expect(pluginMessageDraftIntentSchema.parse(draft)).toEqual(draft);
    expect(
      pluginMessageDraftIntentSchema.safeParse({ ...intent, params }).success,
    ).toBe(false);
  });
  it("puts untitled text in the editable input, images in attachments and keeps other blocks whole as items", () => {
    const draft = pluginMessageDraft(
      draftParams([
        { type: "text", text: "Help me design a bracket." },
        { type: "image", mimeType: "image/png", data: "AQID" },
        {
          type: "text",
          text: "Spec",
          _meta: { "openai/title": "Bracket spec" },
        },
        {
          type: "resource_link",
          uri: "file:///synthetic/part",
          name: "part.stl",
          title: "Hex bolt",
        },
        {
          type: "resource",
          resource: { uri: "fixture://notes", text: "embedded" },
        },
        {
          type: "resource",
          resource: {
            uri: "fixture://img",
            mimeType: "image/png",
            blob: "AQID",
          },
        },
        { type: "text", text: "Thanks." },
      ]),
    );
    expect(draft.text).toBe("Help me design a bracket.\n\nThanks.");
    expect(draft.images).toEqual([{ mimeType: "image/png", data: "AQID" }]);
    expect(draft.items.map((item) => item.title)).toEqual([
      "Bracket spec",
      "Hex bolt",
      "fixture://notes",
      "fixture://img",
    ]);
    expect(draft.items[0].part).toEqual({
      type: "data-plugin-message-text",
      data: { title: "Bracket spec", text: "Spec" },
    });
    expect(JSON.stringify(draft.items[1].part)).toContain(
      "file:///synthetic/part",
    );
    expect(draft.items[2].part).toEqual({ type: "text", text: "embedded" });
    expect(draft.items[3].part).toMatchObject({
      type: "file",
      mediaType: "image/png",
    });
  });
  it("refuses the whole draft when any block is unsupported", () => {
    const value = draftParams([
      { type: "text", text: "kept?" },
      { type: "audio", mimeType: "audio/wav", data: "AQID" },
    ]);
    expect(() => pluginMessageDraft(value)).toThrow();
    expect(
      pluginMessageDraftIntentSchema.safeParse({
        instanceToken: "x".repeat(43),
        operationId: crypto.randomUUID(),
        sourceThreadId: "old",
        params: value,
      }).success,
    ).toBe(false);
  });
});
