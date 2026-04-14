import type { MCPClientCheckDefinition } from "../types.js";
import {
  errorMessage,
  failedResult,
  passedResult,
} from "./helpers.js";

export const RESOURCE_CHECKS: MCPClientCheckDefinition[] = [
  {
    id: "resources-list",
    category: "resources",
    title: "Resources List",
    description: "Server lists resources with uri and name.",
    async run(ctx) {
      const startedAt = Date.now();
      try {
        const result = await ctx.manager.listResources(ctx.serverId);
        const invalidResources = (result.resources ?? [])
          .map((resource, index) => ({ resource, index }))
          .filter(({ resource }) => !resource.uri || !resource.name)
          .map(({ index }) => index);

        if (invalidResources.length > 0) {
          return failedResult(
            this,
            Date.now() - startedAt,
            `Invalid resource definitions at indexes: ${invalidResources.join(", ")}`,
            {
              resourceCount: result.resources?.length ?? 0,
            },
          );
        }

        return passedResult(this, Date.now() - startedAt, {
          resourceCount: result.resources?.length ?? 0,
          resourceUris: (result.resources ?? []).map((resource) => resource.uri),
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
