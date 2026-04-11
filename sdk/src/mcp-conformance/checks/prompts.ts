import type { MCPClientCheckDefinition } from "../types.js";
import {
  errorMessage,
  failedResult,
  passedResult,
} from "./helpers.js";

export const PROMPT_CHECKS: MCPClientCheckDefinition[] = [
  {
    id: "prompts-list",
    category: "prompts",
    title: "Prompts List",
    description: "Server lists prompts with name and description.",
    async run(ctx) {
      const startedAt = Date.now();
      try {
        const result = await ctx.manager.listPrompts(ctx.serverId);
        const invalidPrompts = (result.prompts ?? [])
          .map((prompt, index) => ({ prompt, index }))
          .filter(({ prompt }) => !prompt.name)
          .map(({ index }) => index);

        if (invalidPrompts.length > 0) {
          return failedResult(
            this,
            Date.now() - startedAt,
            `Invalid prompt definitions at indexes: ${invalidPrompts.join(", ")}`,
            {
              promptCount: result.prompts?.length ?? 0,
            },
          );
        }

        return passedResult(this, Date.now() - startedAt, {
          promptCount: result.prompts?.length ?? 0,
          promptNames: (result.prompts ?? []).map((prompt) => prompt.name),
        });
      } catch (error) {
        return failedResult(
          this,
          Date.now() - startedAt,
          errorMessage(error),
          undefined,
          error,
        );
      }
    },
  },
];
