import { tool as aiTool } from "ai";

/** Preserve AI SDK inference while tagging MCPJam's skill implementations. */
export const skillTool: typeof aiTool = (definition) =>
  Object.assign(aiTool(definition), { _toolOrigin: "builtin" as const });
