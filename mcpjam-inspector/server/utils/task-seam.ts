/**
 * Turns a resolved host policy into `getToolsForAiSdk`'s `tasks` option.
 *
 * The SDK seam deliberately does not read host configs — `mcp-client-manager`
 * has no business knowing what a host is — so the mode is resolved here, once,
 * and every execution surface calls this rather than re-deriving the matrix.
 *
 * The one rule worth stating plainly: a surface passes its OWN
 * {@link TaskSurface}. Web chat, local chat and the MCPJam agent all reach the
 * tool seam through `prepareChatV2`, but they are three separate rows in the
 * policy matrix, so the surface travels with the caller and never with the
 * shared plumbing.
 */

import {
  TaskCreatedSink,
  taskModeForSurface,
  toolTaskSeamOptionsFor,
  type TaskCreatedEvent,
  type TaskCreationSurface,
  type TasksPolicy,
  type TaskSurface,
  type ToolTaskAwaitOptions,
  type ToolTaskSeamOptions,
} from "@mcpjam/sdk";
import { logger } from "./logger.js";

/**
 * The policy's surfaces, minus the two that can never create a task.
 *
 * `replay` is excluded because it is `off` in every policy state, and `api`
 * because `/api/v1` refuses both task opt-ins outright. Excluding them here
 * means a caller cannot ask for a seam on a surface that must not have one —
 * the mode check below would return `off` anyway, but a type error is a better
 * place to find out.
 */
export type TaskExecutionSurface = Exclude<TaskSurface, "replay" | "api">;

/** Policy surface → the fan-out event's `surface`. */
const CREATION_SURFACE: Record<TaskExecutionSurface, TaskCreationSurface> = {
  tools: "tools",
  chat: "chat",
  agent: "agent",
  eval: "eval",
  conformance: "conformance",
};

export interface ResolveToolTaskSeamArgs {
  /** Host-only, from `ResolvedExecutionContext`. Never body-supplied. */
  tasksPolicy: TasksPolicy;
  surface: TaskExecutionSurface;
  /** Auth/org context (hosted `projectId`) carried into the task identity. */
  scope?: string;
  /**
   * Consumers of the created-task event. Omit and creations are logged only —
   * which is the correct behavior for a surface with nowhere to deliver them,
   * not a placeholder.
   */
  sink?: TaskCreatedSink;
  /** `await`-mode tuning. Ignored unless the resolved mode is `await`. */
  await?: ToolTaskAwaitOptions;
}

/**
 * @returns seam options, or `undefined` when this surface must not run tasks.
 * `undefined` is the same value a caller passes for "no tasks", so there is
 * exactly one disabled path.
 */
export function resolveToolTaskSeam(
  args: ResolveToolTaskSeamArgs
): ToolTaskSeamOptions | undefined {
  const mode = taskModeForSurface(args.tasksPolicy, args.surface);
  return toolTaskSeamOptionsFor(mode, {
    surface: CREATION_SURFACE[args.surface],
    ...(args.scope !== undefined ? { scope: args.scope } : {}),
    ...(args.await ? { await: args.await } : {}),
    onTaskCreated: async (event: TaskCreatedEvent) => {
      logger.info("[tasks] task created", {
        taskId: event.identity.taskId,
        serverId: event.identity.serverId,
        wire: event.wire,
        surface: event.surface,
        toolName: event.toolName,
      });
      if (!args.sink) return;
      const { degraded } = await args.sink.dispatch(event);
      // Best-effort consumers that failed. Reported, never thrown: the task
      // exists on the server whether or not we recorded a recovery row.
      for (const failure of degraded) {
        logger.warn("[tasks] task-created consumer degraded", {
          consumer: failure.name,
          taskId: event.identity.taskId,
          error:
            failure.error instanceof Error
              ? failure.error.message
              : String(failure.error),
        });
      }
    },
  });
}
