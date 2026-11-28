import { isInputRequiredResult } from "@modelcontextprotocol/server";
import type {
  CallToolResult,
  InputRequiredResult,
  ServerContext,
} from "@modelcontextprotocol/server";
import { findBindingIssues } from "./bindings.js";
import { forRevision } from "./legacy-result.js";
import { stepHostFor, taskStarter } from "./case-call.js";
import { answersItself, toolRunsTasks } from "./definition-types.js";
import type { MockDefinition } from "./definition-types.js";
import type { MockServer } from "./mock-server.js";
import { isTaskCreated } from "./mock-server.js";
import type { MockTasks } from "./mock-tasks.js";
import type { MockNotifier } from "./notifier.js";
import {
  bindingError,
  forwardBlockedError,
  invalidMockCursorError,
  isRealUnreachable,
  toolNotFoundError,
  unknownMethodError,
} from "./mock-errors.js";
import {
  NO_REAL_SERVER,
  type MockForwardDecision,
  type MockRealServer,
} from "./real-server.js";
import type { MockObserver } from "./mock-observer.js";
import { pageOf } from "../server/paging.js";
import { callerLogLevel, relayDuringCall } from "./relay.js";
import { MODERN_REVISION } from "../server/revision.js";
import { planToolCall, resolveMockTools } from "./resolve-tools.js";
import type { MockRecords } from "./record-store.js";
import { answerItself, toolErrorResult } from "./self-answer.js";
import { answerFromState } from "./state-answer.js";

export interface ToolHandlerContext {
  definition: MockDefinition;
  real: MockRealServer;
  observer?: MockObserver;
  /** The protocol revision this request is served under. */
  revision: string;
  /** Where change notifications go, for the call's steps and the real server's list changes. */
  notifierFor: (ctx: ServerContext | undefined) => MockNotifier;
  /** Where the tasks of `task` cases live; without it such a case answers in place. */
  tasks?: MockTasks;
  /** Where the records of `state` tools live; without it such a tool answers with an error. */
  records?: MockRecords;
}

/** The host's answer, or a refusal when the host could not give one. */
export async function decideForward(
  c: Pick<ToolHandlerContext, "real">,
  request: Parameters<MockRealServer["authorizeForward"]>[0],
  signal: AbortSignal
): Promise<MockForwardDecision & { cause?: unknown }> {
  try {
    return await c.real.authorizeForward(request, { signal });
  } catch (cause) {
    // Nothing is dispatched when the check itself failed; the cause goes to the host's log.
    return {
      allowed: false,
      reason: "policy_unavailable",
      message:
        "The mock could not check whether it may call the real server, so it did not. Try again in a moment.",
      cause,
    };
  }
}

/**
 * Calls the real tool, unless the host refuses the forward. A refusal is a tool
 * error naming what to do; a mock with no real tool to call says the call is
 * unmatched. Reports once, after the call settles, with the real tool.
 */
async function forwardCall(
  c: ToolHandlerContext,
  name: string,
  plan: { realName: string; arguments: Record<string, unknown> },
  ctx: ServerContext,
  progressToken: string | number | undefined
): Promise<CallToolResult | InputRequiredResult> {
  const { real, observer } = c;
  const decision = await decideForward(
    c,
    {
      kind: "tool",
      tool: name,
      realTool: plan.realName,
      arguments: plan.arguments,
    },
    ctx.mcpReq.signal
  );
  if (!decision.allowed) {
    const unmatched = decision.reason === "no_base";
    observer?.({
      tool: name,
      source: unmatched ? "unmatched" : "blocked",
      ...(!unmatched && { realTool: plan.realName }),
      refusal: decision.reason,
      ...("cause" in decision && { cause: decision.cause }),
    });
    return toolErrorResult(decision.message);
  }
  const relay = relayDuringCall(real, progressToken, ctx, c.notifierFor(ctx));
  try {
    const result = await real.callTool({
      name: plan.realName,
      arguments: plan.arguments,
      signal: ctx.mcpReq.signal,
      // A 2025 caller sends no level with the request, and a server it talks to
      // directly logs everything unless it was told a level; ask for all, and
      // the mock's own session level (if the caller set one) filters what
      // goes on to the caller.
      logLevel:
        callerLogLevel(ctx) ??
        (c.revision === MODERN_REVISION ? undefined : "debug"),
      onProgress: relay.onProgress,
      onLog: relay.onLog,
      inputResponses: ctx.mcpReq.inputResponses,
      requestState: ctx.mcpReq.requestState(),
    });
    await relay.flush();
    if (isInputRequiredResult(result) && c.revision !== "2026-07-28") {
      return toolErrorResult(
        `The real server asked a question while running ${plan.realName}, and a connection on protocol revision ${c.revision} cannot be asked one through a mock. Connect with 2026-07-28.`
      );
    }
    return forRevision(result, c.revision);
  } catch (error) {
    // A call that needs the live base says so, as a tool error the agent can
    // read; the mock's own saved answers never reach this path.
    if (isRealUnreachable(error)) return toolErrorResult(error.message);
    throw error;
  } finally {
    relay.stop();
    observer?.({ tool: name, source: "forwarded", realTool: plan.realName });
  }
}

/** `tools/list` and `tools/call`: the definition laid over the real server's tools. */
export function registerToolHandlers(
  server: MockServer,
  c: ToolHandlerContext
): void {
  const { definition, real, observer } = c;

  server.setRequestHandler("tools/list", async (request, ctx) => {
    const realTools = await real.listTools({ signal: ctx.mcpReq.signal });
    const issues = findBindingIssues(definition, realTools);
    if (issues.length > 0) throw bindingError(issues);
    const { tools } = resolveMockTools(definition, realTools);
    // 2025-11-25 lets a client run a tool as a task only when the tool says so.
    const listed =
      c.revision === "2025-11-25" && c.tasks
        ? tools.map((tool) =>
            toolRunsTasks(definition.tools?.[tool.name]) && !tool.execution
              ? { ...tool, execution: { taskSupport: "optional" as const } }
              : tool
          )
        : tools;
    const page = pageOf(listed, request.params?.cursor, definition.pageSize, {
      invalidCursor: invalidMockCursorError,
    });
    return {
      tools: page.items,
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  });

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name;
    const plan = planToolCall(definition, name, request.params.arguments);
    if (!plan) throw toolNotFoundError(name);
    const entry = definition.tools?.[name];
    const answer = entry?.answer;
    // An override that forwards is checked against the real tool it depends on
    // before anything is sent, so a repairable mismatch is named, not guessed.
    if (entry && real !== NO_REAL_SERVER && !answersItself(entry)) {
      const issues = findBindingIssues(
        { tools: { [name]: entry } },
        await real.listTools({ signal: ctx.mcpReq.signal })
      );
      if (issues.length > 0) throw bindingError(issues);
    }
    const state = entry?.state;
    if (state) {
      const realTools = await real.listTools({ signal: ctx.mcpReq.signal });
      return answerFromState({
        tool: resolveMockTools(definition, realTools).tools.find(
          (tool) => tool.name === name
        ),
        name,
        state,
        input: request.params.arguments ?? {},
        meta: request.params._meta,
        records: c.records,
        observer,
      });
    }
    if (answer?.from === "saved") {
      const realTools = await real.listTools({ signal: ctx.mcpReq.signal });
      const answered = await answerItself({
        tool: resolveMockTools(definition, realTools).tools.find(
          (tool) => tool.name === name
        ),
        name,
        answer,
        input: request.params.arguments ?? {},
        realHasTool: realTools.some((tool) => tool.name === plan.realName),
        observer,
        canAsk: c.revision === "2026-07-28",
        caseCall: {
          host: stepHostFor(
            ctx,
            request.params._meta?.progressToken,
            c.notifierFor(ctx)
          ),
          responses: ctx.mcpReq.inputResponses,
          requestState: ctx.mcpReq.requestState(),
          startTask: taskStarter(
            c.tasks,
            c.revision,
            ctx,
            (request.params as { task?: unknown }).task,
            c.notifierFor(undefined)
          ),
        },
      });
      if (isTaskCreated(answered)) {
        server.holdTask(ctx.mcpReq.id, answered.taskCreated);
        return { content: [] };
      }
      if (answered) return answered;
    }
    return forwardCall(c, name, plan, ctx, request.params._meta?.progressToken);
  });
}

/** Refuses a forward of any other method, as a JSON-RPC error, when the host does not allow it. */
export async function assertRequestForward(
  c: Pick<ToolHandlerContext, "real">,
  method: string,
  signal: AbortSignal
): Promise<void> {
  const decision = await decideForward(c, { kind: "request", method }, signal);
  if (!decision.allowed) {
    // A mock with no real server has no such method to forward; say so as a server would.
    if (decision.reason === "no_base") throw unknownMethodError(method);
    throw forwardBlockedError(method, decision.reason, decision.message);
  }
}
