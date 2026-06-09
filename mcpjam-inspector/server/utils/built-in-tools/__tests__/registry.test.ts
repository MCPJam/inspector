import { describe, it, expect } from "vitest";
import {
  resolveBuiltInTools,
  BUILT_IN_TOOL_FACTORIES,
  type BuiltInToolContext,
} from "../registry.js";
import { WEB_SEARCH_TOOL_NAME } from "../exa-web-search.js";

const ctx: BuiltInToolContext = {
  authHeader: "Bearer test",
  projectId: "proj_1",
  chatSessionId: "sess_1",
};

describe("resolveBuiltInTools", () => {
  it("resolves a known catalog id into a ToolSet keyed by the tool name", () => {
    const tools = resolveBuiltInTools([WEB_SEARCH_TOOL_NAME], ctx);
    expect(Object.keys(tools)).toEqual([WEB_SEARCH_TOOL_NAME]);
    const built = tools[WEB_SEARCH_TOOL_NAME];
    expect(built).toBeDefined();
    expect(typeof (built as { execute?: unknown }).execute).toBe("function");
  });

  it("returns an empty set for undefined / empty ids", () => {
    expect(resolveBuiltInTools(undefined, ctx)).toEqual({});
    expect(resolveBuiltInTools([], ctx)).toEqual({});
  });

  it("fails closed on an unknown id (never silently drops a tool)", () => {
    expect(() => resolveBuiltInTools(["not_a_real_tool"], ctx)).toThrow(
      /no factory registered for built-in tool "not_a_real_tool"/,
    );
  });

  it("registers web_search in the factory map", () => {
    expect(typeof BUILT_IN_TOOL_FACTORIES[WEB_SEARCH_TOOL_NAME]).toBe(
      "function",
    );
  });
});
