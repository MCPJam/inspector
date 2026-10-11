import { describe, expect, it } from "vitest";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { mcpAppToolResultSchema } from "../../src/widget-runtime/tool-result-schema.js";

describe("official MCP Apps normalized tool-result boundary", () => {
  it("retains every ordinary result block, metadata and opaque extension exactly", () => {
    const result = {
      content: [
        {
          type: "text",
          text: "text",
          annotations: { audience: ["assistant"] },
          _meta: { "fixture/block": { nested: true } },
        },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "audio", data: "AAAA", mimeType: "audio/wav" },
        {
          type: "resource_link",
          uri: "fixture://part",
          name: "part",
          icons: [{ src: "https://example.test/part.png" }],
        },
        {
          type: "resource",
          resource: {
            uri: "fixture://text",
            text: "embedded",
            mimeType: "text/plain",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "fixture://binary",
            blob: "AAAA",
            mimeType: "application/octet-stream",
          },
        },
      ],
      structuredContent: { full: { nested: [1, 2] } },
      _meta: { "fixture/private": { exact: true } },
      fixtureExtension: { opaque: "retained" },
    };
    expect(mcpAppToolResultSchema.parse(result)).toEqual(result);
    expect(mcpAppToolResultSchema.parse(result)).toEqual(
      CallToolResultSchema.parse(result)
    );
  });
  it.each([
    null,
    { content: "invalid" },
    { content: [{ type: "text" }] },
    { content: [{ type: "image", data: 1, mimeType: "image/png" }] },
    { content: [{ type: "resource_link", uri: "fixture://part" }] },
    { content: [{ type: "unknown", text: "no" }] },
    { content: [], structuredContent: "invalid" },
    { content: [], isError: "true" },
    { content: [], _meta: "invalid" },
  ])(
    "matches the established result schema for invalid whole results %#",
    (value) => {
      expect(mcpAppToolResultSchema.safeParse(value).success).toBe(false);
      expect(mcpAppToolResultSchema.safeParse(value).success).toBe(
        CallToolResultSchema.safeParse(value).success
      );
    }
  );
  it("retains the standard default content and error-result contract", () => {
    for (const value of [
      {},
      { isError: true, content: [{ type: "text", text: "denied" }] },
    ])
      expect(mcpAppToolResultSchema.parse(value)).toEqual(
        CallToolResultSchema.parse(value)
      );
  });
});
