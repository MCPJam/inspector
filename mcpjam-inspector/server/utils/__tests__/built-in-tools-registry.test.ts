import { describe, expect, it } from "vitest";
import {
  resolveBuiltInTools,
  safeResolveBuiltInTools,
} from "../built-in-tools/registry";
import { WEB_SEARCH_TOOL_NAME } from "../built-in-tools/exa-web-search";

const ctx = {
  authHeader: "Bearer token-123",
  projectId: "project-1",
  chatSessionId: "session-1",
};

describe("resolveBuiltInTools", () => {
  it("resolves web_search to a runnable tool", () => {
    const tools = resolveBuiltInTools([WEB_SEARCH_TOOL_NAME], ctx);

    expect(Object.keys(tools)).toEqual([WEB_SEARCH_TOOL_NAME]);
    expect(typeof tools[WEB_SEARCH_TOOL_NAME].execute).toBe("function");
  });

  it("skips unknown ids instead of throwing", () => {
    const tools = resolveBuiltInTools(
      ["not_a_tool", WEB_SEARCH_TOOL_NAME],
      ctx,
    );

    expect(Object.keys(tools)).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("returns an empty set for undefined / empty ids", () => {
    expect(resolveBuiltInTools(undefined, ctx)).toEqual({});
    expect(resolveBuiltInTools([], ctx)).toEqual({});
  });
});

describe("safeResolveBuiltInTools", () => {
  it("returns undefined when there is nothing to resolve", () => {
    expect(safeResolveBuiltInTools(undefined, ctx)).toBeUndefined();
    expect(safeResolveBuiltInTools([], ctx)).toBeUndefined();
  });

  it("returns undefined without auth context (local BYOK paths)", () => {
    expect(
      safeResolveBuiltInTools([WEB_SEARCH_TOOL_NAME], null),
    ).toBeUndefined();
  });

  it("returns undefined when every requested id is unknown", () => {
    expect(safeResolveBuiltInTools(["not_a_tool"], ctx)).toBeUndefined();
  });

  it("does not double-prefix a lowercase bearer scheme", () => {
    // RFC 7235 schemes are case-insensitive; "bearer x" must pass through
    // instead of becoming "Bearer bearer x".
    const tools = resolveBuiltInTools([WEB_SEARCH_TOOL_NAME], {
      authHeader: "bearer token-123",
      projectId: "project-1",
    });

    expect(Object.keys(tools)).toEqual([WEB_SEARCH_TOOL_NAME]);
  });

  it("resolves with auth context, raw bearer accepted", () => {
    // Eval threads `convexAuthToken` without the "Bearer " prefix; the
    // registry normalizes, so the same call shape works for both.
    const tools = safeResolveBuiltInTools([WEB_SEARCH_TOOL_NAME], {
      authHeader: "raw-token",
      projectId: "project-1",
    });

    expect(tools).toBeDefined();
    expect(Object.keys(tools!)).toEqual([WEB_SEARCH_TOOL_NAME]);
  });
});
