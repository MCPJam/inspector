import type { MCPClientCheckDefinition } from "../types.js";
import {
  errorMessage,
  failedResult,
  passedResult,
} from "./helpers.js";

function selectCompletionReference(ctx: Parameters<
  MCPClientCheckDefinition["run"]
>[0]) {
  if (ctx.availablePrompts.includes("test_prompt_with_arguments")) {
    return {
      ref: {
        type: "ref/prompt" as const,
        name: "test_prompt_with_arguments",
      },
      argument: {
        name: "arg1",
        value: "par",
      },
    };
  }

  if (ctx.availablePrompts[0]) {
    return {
      ref: {
        type: "ref/prompt" as const,
        name: ctx.availablePrompts[0],
      },
      argument: {
        name: "value",
        value: "par",
      },
    };
  }

  if (ctx.availableResourceTemplates[0]) {
    return {
      ref: {
        type: "ref/resource" as const,
        uri: ctx.availableResourceTemplates[0],
      },
      argument: {
        name: "id",
        value: "123",
      },
    };
  }

  return undefined;
}

export const CORE_CHECKS: MCPClientCheckDefinition[] = [
  {
    id: "server-initialize",
    category: "core",
    title: "Server Initialize",
    description: "Server responds to initialize and reports capabilities.",
    async run(ctx) {
      const startedAt = Date.now();
      const info = ctx.initializationInfo;
      if (!info) {
        return failedResult(
          this,
          Date.now() - startedAt,
          "Initialization info is unavailable after connecting to the server",
        );
      }

      return passedResult(this, Date.now() - startedAt, {
        protocolVersion: info.protocolVersion,
        transport: info.transport,
        serverCapabilities: info.serverCapabilities as Record<string, unknown>,
        serverVersion: info.serverVersion as Record<string, unknown>,
      });
    },
  },
  {
    id: "ping",
    category: "core",
    title: "Ping",
    description: "Server responds to ping requests.",
    async run(ctx) {
      const startedAt = Date.now();
      try {
        const result = await ctx.manager.pingServer(ctx.serverId);
        return passedResult(this, Date.now() - startedAt, {
          result: result as Record<string, unknown>,
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
  {
    id: "logging-set-level",
    category: "core",
    title: "Logging Set Level",
    description: "Server accepts logging/setLevel requests.",
    async run(ctx) {
      const startedAt = Date.now();
      if (!ctx.initializationInfo?.serverCapabilities?.logging) {
        return {
          ...this,
          status: "skipped" as const,
          durationMs: 0,
          error: {
            message: "Server does not advertise the optional logging capability",
          },
        };
      }

      try {
        const result = await ctx.client.setLoggingLevel("info");
        const isEmptyObject =
          typeof result === "object" &&
          result !== null &&
          Object.keys(result).length === 0;

        if (!isEmptyObject) {
          return failedResult(
            this,
            Date.now() - startedAt,
            "logging/setLevel did not return an empty object",
            {
              result: result as Record<string, unknown>,
            },
          );
        }

        return passedResult(this, Date.now() - startedAt, {
          result: result as Record<string, unknown>,
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
  {
    id: "completion-complete",
    category: "core",
    title: "Completion Complete",
    description: "Server responds to completion/complete requests.",
    async run(ctx) {
      const startedAt = Date.now();
      if (!ctx.initializationInfo?.serverCapabilities?.completions) {
        return {
          ...this,
          status: "skipped" as const,
          durationMs: 0,
          error: {
            message:
              "Server does not advertise the optional completions capability",
          },
        };
      }

      const completionReference = selectCompletionReference(ctx);
      if (!completionReference) {
        return {
          ...this,
          status: "skipped" as const,
          durationMs: 0,
          error: {
            message:
              "Server does not expose a prompt or resource template suitable for completion testing",
          },
        };
      }

      try {
        const result = await ctx.client.complete(completionReference);
        if (!Array.isArray(result.completion.values)) {
          return failedResult(
            this,
            Date.now() - startedAt,
            "completion/complete did not return a values array",
            {
              result: result as Record<string, unknown>,
            },
          );
        }

        return passedResult(this, Date.now() - startedAt, {
          completion: result.completion as Record<string, unknown>,
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
