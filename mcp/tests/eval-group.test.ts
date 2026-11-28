/**
 * `mcpjam mcp --evals` serves the eval group the SDK names. Operations carry
 * no domain, so the group is a list, and this keeps it in step with the tools
 * this server lists: a new eval tool fails here until it is in the group or
 * named as belonging to another flow.
 */
import { describe, expect, it } from "vitest";
import {
  EVAL_TOOL_NAMES,
  HELD_OPERATION_NAMES,
  localEvalToolNames,
  NOT_EVAL_TOOL_NAMES,
} from "@mcpjam/sdk/internal/mcp-surface";
import { PLATFORM_CATALOG_OPERATIONS } from "../src/tools/platformTools.js";

const hosted = new Set(PLATFORM_CATALOG_OPERATIONS.map(({ name }) => name));
const group = new Set<string>(EVAL_TOOL_NAMES);

describe("the eval group local MCP serves", () => {
  it("has every eval tool this server lists, or names why not", () => {
    const missing = [...hosted].filter(
      (name) =>
        name.includes("eval") && !group.has(name) && !NOT_EVAL_TOOL_NAMES.has(name)
    );
    expect(missing).toEqual([]);
  });

  it("names only tools this server lists or holds while in beta", () => {
    const unknown = EVAL_TOOL_NAMES.filter(
      (name) => !hosted.has(name) && !HELD_OPERATION_NAMES.has(name)
    );
    expect(unknown).toEqual([]);
  });

  it("serves locally exactly what this server lists from the group", () => {
    expect(localEvalToolNames().every((name) => hosted.has(name))).toBe(true);
    expect(
      EVAL_TOOL_NAMES.filter((name) => hosted.has(name)).sort()
    ).toEqual([...localEvalToolNames()].sort());
  });
});
