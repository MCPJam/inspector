import type {
  CompleteResult,
  Result,
  Server,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { answerCompletion } from "./completions.js";
import { forwardToReal } from "./item-handlers.js";
import type { ItemHandlerContext } from "./item-handlers.js";
import {
  isForwardBlocked,
  isRealUnreachable,
  methodUnavailableError,
  unknownMethodError,
} from "./mock-errors.js";
import {
  answerTaskMethod,
  heldTasks,
  TASKS_EXTENSION_ID,
  unknownCursor,
  unknownTask,
} from "./mock-tasks.js";
import type { MockTasks } from "./mock-tasks.js";
import { planResourceRead } from "./resolve-items.js";
import { decideForward } from "./tool-handlers.js";

type Obj = Record<string, unknown>;

/** `completion/complete`: the definition's suggestions, or the real server's. */
export function registerCompletionHandler(
  server: Server,
  c: ItemHandlerContext
): void {
  server.setRequestHandler(
    "completion/complete",
    async (request, ctx) =>
      (await answerCompletion(
        c,
        request.params,
        ctx.mcpReq.signal
      )) as CompleteResult
  );
}

/**
 * `resources/subscribe` and `resources/unsubscribe` (2025-era revisions;
 * 2026-07-28 replaced them with `subscriptions/listen`). A resource of the
 * real server is passed through after the host allows it. A resource the mock
 * owns is acknowledged with nothing to register: the mock keeps no session, so
 * an update reaches a client only on the stream of the call that announced it
 * (a saved case's `resourceUpdated` step).
 */
export function registerSubscribeHandlers(
  server: Server,
  c: ItemHandlerContext
): void {
  for (const method of [
    "resources/subscribe",
    "resources/unsubscribe",
  ] as const) {
    server.setRequestHandler(method, async (request, ctx) => {
      const { uri } = request.params;
      const own = planResourceRead(c.definition, uri).kind === "own";
      if (own || !c.realCapabilities.resources?.subscribe) return {};
      return (await forwardToReal(
        c,
        method,
        { uri },
        ctx.mcpReq.signal
      )) as Result;
    });
  }
}

/** Whether the real server runs tasks itself, on either wire. */
export function realHasTasks(c: ItemHandlerContext): boolean {
  const { tasks, extensions } = c.realCapabilities;
  return Boolean(tasks ?? extensions?.[TASKS_EXTENSION_ID]);
}

/**
 * A task method this mock's store does not hold. When the real server has
 * tasks it is the real server's task, passed through after the host allows
 * it; otherwise no such task exists.
 */
export async function taskNotHeld(
  c: ItemHandlerContext,
  method: string,
  params: Obj | undefined,
  signal: AbortSignal
): Promise<Obj> {
  if (!realHasTasks(c)) throw unknownTask();
  if (!c.mockCapabilities.tasks && !c.mockCapabilities.extensions) {
    throw methodUnavailableError(method, "mock", "tasks");
  }
  try {
    return await forwardToReal(c, method, params, signal);
  } catch (cause) {
    // As in the general fallback: the MCP client throws a TypeError for a
    // method outside the spec, and no server has such a method.
    if (cause instanceof TypeError) throw unknownMethodError(method);
    throw cause;
  }
}

/**
 * The 2025-11-25 `tasks/list`. This mock's own tasks all come on the first
 * page, followed by the real server's first page when it lists tasks too.
 * The mock hands out no cursor of its own, so a cursor is the real server's
 * and goes back to it unchanged.
 */
export async function listLegacyTasks(
  tasks: MockTasks,
  c: ItemHandlerContext,
  params: Obj | undefined,
  signal: AbortSignal
): Promise<Obj> {
  const realLists = Boolean(c.realCapabilities.tasks?.list);
  // A real server that runs tasks but cannot list them has tasks `tasks/get`
  // can read and this list cannot name.
  if (c.realCapabilities.tasks && !realLists) {
    throw methodUnavailableError("tasks/list", "real", "task listing");
  }
  if (params?.cursor !== undefined) {
    if (!realLists) throw unknownCursor();
    return forwardToReal(c, "tasks/list", params, signal);
  }
  // A list must name every task `tasks/get` can read, so a failure on either
  // side fails it. The mock's own tasks are the whole list only when no read
  // can reach the real server's: it is unreachable, or forwarding is refused
  // for `tasks/get` as well.
  const own = await heldTasks(tasks);
  if (!realLists) return { tasks: own };
  try {
    const page = await forwardToReal(c, "tasks/list", params, signal);
    const theirs = Array.isArray(page.tasks) ? page.tasks : [];
    return { ...page, tasks: [...own, ...theirs] };
  } catch (error) {
    if (isRealUnreachable(error)) return { tasks: own };
    if (isForwardBlocked(error)) {
      const get = await decideForward(
        c,
        { kind: "request", method: "tasks/get" },
        signal
      );
      if (!get.allowed) return { tasks: own };
    }
    throw error;
  }
}

/**
 * The 2026-07-28 extension reuses two method names the core dropped, so the
 * server SDK dispatches them only to a handler registered with its own params
 * schema. The 2025-11-25 utility's methods come through the fallback handler.
 */
export function registerTaskExtensionHandlers(
  server: Server,
  c: ItemHandlerContext,
  tasks: MockTasks
): void {
  const params = { params: z.looseObject({ taskId: z.string() }) };
  for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
    server.setRequestHandler(method, params, async (taskParams, ctx) => {
      // The server SDK lifts the replies out of the params.
      const withReplies = {
        ...taskParams,
        ...(ctx.mcpReq.inputResponses && {
          inputResponses: ctx.mcpReq.inputResponses,
        }),
      };
      const answered = await answerTaskMethod(
        tasks,
        "extension",
        method,
        withReplies,
        ctx.mcpReq.signal
      );
      return (answered ??
        (await taskNotHeld(
          c,
          method,
          withReplies,
          ctx.mcpReq.signal
        ))) as Result;
    });
  }
}
