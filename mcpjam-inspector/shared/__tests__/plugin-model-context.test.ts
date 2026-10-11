import { describe, expect, it } from "vitest";
import {
  parsePluginModelContext,
  pluginModelContextMessage,
  appendPluginModelContext,
  stripPluginModelContext,
  PLUGIN_CONTEXT_MAX_BYTES,
  pluginContextAttachments,
} from "../plugin-model-context";
import { modelMessageSchema, type ModelMessage } from "ai";

const context = (content: unknown[]) => ({
  instanceId: "private-instance",
  generation: 1,
  updateId: "private-update",
  content,
});
describe("plugin per-turn context boundary", () => {
  it("presents titles/thumbnails and hides exactly assistant-only audience without dropping model data", () => {
    const content = parsePluginModelContext({
      content: [
        {
          type: "text",
          text: "hidden",
          annotations: { audience: ["assistant"] },
        },
        {
          type: "text",
          text: "visible",
          annotations: { audience: ["user", "assistant"] },
          _meta: {
            "openai/title": "A title",
            "openai/thumbnail": { src: "https://example.test/image.png" },
          },
        },
        {
          type: "image",
          data: "iVBORw0KGgo=",
          mimeType: "image/png",
          _meta: { "openai/title": "Image alt" },
        },
      ],
    }).content!;
    expect(
      pluginContextAttachments({
        revision: 1,
        sequence: 1,
        state: { updateId: "update", content },
      }),
    ).toMatchObject([
      {
        index: 1,
        title: "A title",
        thumbnail: { src: "https://example.test/image.png" },
      },
      { index: 2, title: "Image alt" },
    ]);
    expect(
      JSON.stringify(pluginModelContextMessage([context(content)])),
    ).toContain("hidden");
    expect(
      JSON.stringify(pluginModelContextMessage([context(content)])),
    ).not.toMatch(/A title|Image alt|example.test/);
  });
  it("keeps content order and real image bytes while removing presentation metadata", () => {
    const image = {
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
      _meta: { thumbnail: "private-url" },
    };
    const input = [
      context([
        {
          type: "text",
          text: "before",
          annotations: { audience: ["assistant"] },
          _meta: { title: "private-title" },
        },
        image,
        { type: "text", text: "after" },
      ]),
    ];
    const message = pluginModelContextMessage(input)!;
    expect(message.role).toBe("user");
    const parts = message.content as any[];
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "text",
      "image",
      "text",
    ]);
    expect(
      Array.from(atob(parts[2].image), (char) => char.charCodeAt(0)),
    ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(parts[2].mediaType).toBe("image/png");
    const serialized = JSON.parse(JSON.stringify(message));
    expect(serialized.content[2].image).toBe(parts[2].image);
    expect(modelMessageSchema.safeParse(serialized).success).toBe(true);
    expect(JSON.stringify(message)).not.toMatch(/private-|thumbnail|audience/);
  });
  it("keeps removable link titles and hidden audience while encoding only inert reference metadata", () => {
    const link = {
      type: "resource_link",
      uri: "file:///synthetic/reference",
      name: "Reference π",
      title: "Link title",
      description: "Untrusted note",
      _meta: { credential: "private-link" },
      icons: [{ src: "https://example.invalid/no-read" }],
    };
    const hidden = {
      ...link,
      name: "Hidden",
      annotations: { audience: ["assistant"] },
    };
    const content = parsePluginModelContext({
      content: [link, hidden],
    }).content!;
    const items = pluginContextAttachments({
      revision: 1,
      sequence: 1,
      state: { updateId: "original", content },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      index: 0,
      title: "Link title",
      block: link,
    });
    const message = pluginModelContextMessage([context(content)]);
    const model = JSON.stringify(message);
    expect(model).toContain("file:///synthetic/reference");
    expect(model).toContain("Hidden");
    expect(model).toContain("does not grant access");
    expect(model).not.toMatch(/private-link|no-read|annotations|icons/);
  });
  it("puts context beside the real question and strips it before history persistence", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "old" },
      { role: "assistant", content: "prior" },
      { role: "user", content: "actual question" },
    ];
    const updated = appendPluginModelContext(
      messages,
      pluginModelContextMessage([
        context([{ type: "text", text: "current selection" }]),
      ]),
    );
    expect(updated[2].content).toEqual(
      expect.arrayContaining([
        { type: "text", text: "actual question" },
        expect.objectContaining({ text: "current selection" }),
      ]),
    );
    expect(updated[0]).toBe(messages[0]);
    expect(messages[2].content).toBe("actual question");
    expect(stripPluginModelContext(updated)[2].content).toEqual([
      { type: "text", text: "actual question" },
    ]);
  });
  it("delivers embedded text/image bytes in order without exposing resource URIs or metadata", () => {
    const content = [
      { type: "text", text: "before" },
      {
        type: "resource",
        resource: {
          uri: "file:///private/synthetic.txt",
          text: "embedded café\nexact text",
          _meta: { credential: "private-metadata" },
        },
        _meta: { "openai/title": "Embedded note" },
      },
      {
        type: "resource",
        resource: {
          uri: "https://example.invalid/do-not-fetch.png",
          mimeType: "image/png",
          blob: "iVBORw0KGgo=",
        },
      },
      { type: "text", text: "after" },
    ];
    const parsed = parsePluginModelContext({ content });
    const message = pluginModelContextMessage([context(parsed.content!)]);
    const parts = message!.content as any[];
    expect(parts.map((p) => p.type)).toEqual([
      "text",
      "text",
      "text",
      "image",
      "text",
    ]);
    expect(parts[2].text).toBe("embedded café\nexact text");
    expect(
      Array.from(atob(parts[3].image), (char) => char.charCodeAt(0)),
    ).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(JSON.stringify(message)).not.toMatch(
      /private-|file:|https:|Embedded note/,
    );
    const attachments = pluginContextAttachments({
      revision: 1,
      sequence: 1,
      state: { updateId: "update", content: parsed.content! },
    });
    expect(attachments[1].title).toBe("Embedded note");
    expect(attachments[2].image).toMatchObject({
      type: "image",
      data: "iVBORw0KGgo=",
    });
    expect(parsed.content).toEqual(content);
  });
  it.each([
    { type: "audio", mimeType: "audio/wav", data: "AAAA" },
    { type: "resource_link", uri: "file:///private" },
    { type: "image", mimeType: "image/svg+xml", data: "AAAA" },
    { type: "image", mimeType: "image/png", data: "https://private" },
    { type: "image", mimeType: "image/png", data: "AB==" },
    {
      type: "resource",
      resource: {
        uri: "fixture://x",
        mimeType: "application/pdf",
        blob: "AAAA",
      },
    },
    {
      type: "resource",
      resource: { uri: "fixture://x", mimeType: "image/png", blob: "AB==" },
    },
    {
      type: "resource",
      resource: {
        uri: "fixture://x",
        text: "text",
        blob: "AAAA",
        mimeType: "image/png",
      },
    },
  ])(
    "refuses the whole unsupported request without text fallback",
    (unsupported) => {
      expect(() =>
        parsePluginModelContext({
          content: [{ type: "text", text: "valid" }, unsupported],
        }),
      ).toThrow();
    },
  );
  it("bounds updates/turns, clones input, preserves live metadata and handles removal", () => {
    const input = {
      content: [{ type: "text", text: "state" }],
      _meta: { "fixture/request": { full: true } },
    };
    const parsed = parsePluginModelContext(input);
    input.content[0].text = "changed";
    expect(parsed.content?.[0]).toMatchObject({ text: "state" });
    expect(parsed._meta).toEqual(input._meta);
    expect(() =>
      parsePluginModelContext({
        content: [{ type: "text", text: "x".repeat(PLUGIN_CONTEXT_MAX_BYTES) }],
      }),
    ).toThrow("TOO_LARGE");
    expect(() => parsePluginModelContext({ unknown: true })).toThrow();
    expect(pluginModelContextMessage([context([])])).toBeUndefined();
    expect(() =>
      pluginModelContextMessage(
        Array.from({ length: 6 }, () =>
          context([{ type: "text", text: "x".repeat(200_000) }]),
        ),
      ),
    ).toThrow("TURN_TOO_LARGE");
  });
});

it("projects structured-only state as one removable generic context attachment", () => {
  const snapshot = {
    revision: 1,
    sequence: 1,
    state: {
      updateId: "structured",
      content: [],
      structuredContent: { private: "data" },
    },
  };
  expect(pluginContextAttachments(snapshot)).toMatchObject([
    { index: 0, title: "App context" },
  ]);
  expect(JSON.stringify(pluginContextAttachments(snapshot))).not.toContain(
    "private",
  );
});
