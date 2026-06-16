import { describe, expect, it } from "vitest";
import { toCallToolResult } from "../tool-result-utils";

describe("toCallToolResult", () => {
  it("re-envelopes a bare structured payload so structuredContent resolves", () => {
    // The platform `show_servers` payload as the chat pipeline collapses it:
    // a bare object with no `content`/`structuredContent` wrapper.
    const payload = {
      project: { id: "p1", name: "Default" },
      servers: [{ name: "notion" }],
      widget: "servers",
    };

    const result = toCallToolResult(payload);

    expect(result.structuredContent).toEqual(payload);
    expect(result.content).toEqual([]);
  });

  it("passes through a real CallToolResult unchanged (no double-wrap)", () => {
    const real = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { project: { id: "p1" }, servers: [] },
      _meta: { _serverId: "mcpjam-platform" },
    };

    const result = toCallToolResult(real);

    expect(result).toBe(real);
    expect(result.structuredContent).toEqual(real.structuredContent);
  });

  it("passes through a content-only CallToolResult without inventing structuredContent", () => {
    const real = { content: [{ type: "text", text: "hi" }] };

    const result = toCallToolResult(real);

    expect(result).toBe(real);
    expect(result.structuredContent).toBeUndefined();
  });

  it("unwraps an AI-SDK { value, _meta } wrapper around a bare payload", () => {
    const payload = { project: { id: "p1" }, servers: [] };
    const wrapped = { value: payload, _meta: { _serverId: "s1" } };

    const result = toCallToolResult(wrapped);

    expect(result.structuredContent).toEqual(payload);
    expect(result._meta).toEqual({ _serverId: "s1" });
  });

  it("unwraps a { value } wrapper around a real CallToolResult", () => {
    const inner = {
      content: [{ type: "text", text: "ok" }],
      structuredContent: { project: { id: "p1" }, servers: [] },
    };
    const wrapped = { value: inner };

    const result = toCallToolResult(wrapped);

    expect(result).toBe(inner);
  });

  it("returns an empty result for non-object output", () => {
    expect(toCallToolResult(undefined)).toEqual({ content: [] });
    expect(toCallToolResult("oops")).toEqual({ content: [] });
    expect(toCallToolResult(null)).toEqual({ content: [] });
  });
});
