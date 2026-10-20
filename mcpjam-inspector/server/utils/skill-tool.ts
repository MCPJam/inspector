import { tool as aiTool, type Tool, type ToolExecuteFunction } from "ai";

/** Skill tools always have executors; keep their schema and context types. */
export function skillTool<
  INPUT,
  OUTPUT,
  CONTEXT extends Record<string, unknown>,
>(
  definition: Tool<INPUT, OUTPUT, CONTEXT> & {
    execute: ToolExecuteFunction<INPUT, OUTPUT, CONTEXT>;
  },
) {
  return Object.assign(aiTool(definition), {
    _toolOrigin: "builtin" as const,
  });
}
