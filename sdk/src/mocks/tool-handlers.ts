import type {
  CallToolResult,
  Server,
  ServerContext,
} from "@modelcontextprotocol/server";
import type { MockDefinition } from "./definition-types.js";
import {
  editedToolMissingError,
  forwardBlockedError,
  toolNotFoundError,
  unknownMethodError,
} from "./mock-errors.js";
import type { MockForwardDecision, MockRealServer } from "./real-server.js";
import type { MockObserver } from "./mock-observer.js";
import { pageOf } from "./paging.js";
import { callerLogLevel, relayDuringCall } from "./relay.js";
import { planToolCall, resolveMockTools } from "./resolve-tools.js";
import { answerItself, toolErrorResult } from "./self-answer.js";

export interface ToolHandlerContext {
  definition: MockDefinition;
  real: MockRealServer;
  observer?: MockObserver;
}

/** The host's answer, or a refusal when the host could not give one. */
async function decideForward(
  c: ToolHandlerContext,
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
): Promise<CallToolResult> {
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
  const relay = relayDuringCall(real, progressToken, ctx);
  try {
    const result = await real.callTool({
      name: plan.realName,
      arguments: plan.arguments,
      signal: ctx.mcpReq.signal,
      logLevel: callerLogLevel(ctx),
      onProgress: relay.onProgress,
      onLog: relay.onLog,
    });
    await relay.flush();
    return result;
  } finally {
    relay.stop();
    observer?.({ tool: name, source: "forwarded", realTool: plan.realName });
  }
}

/** `tools/list` and `tools/call`: the definition laid over the real server's tools. */
export function registerToolHandlers(
  server: Server,
  c: ToolHandlerContext
): void {
  const { definition, real, observer } = c;

  server.setRequestHandler("tools/list", async (request, ctx) => {
    const { tools, missing } = resolveMockTools(
      definition,
      await real.listTools({ signal: ctx.mcpReq.signal })
    );
    if (missing.length > 0) throw editedToolMissingError(missing);
    const page = pageOf(tools, request.params?.cursor, definition.pageSize);
    return {
      tools: page.items,
      ...(page.nextCursor && { nextCursor: page.nextCursor }),
    };
  });

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const name = request.params.name;
    const plan = planToolCall(definition, name, request.params.arguments);
    if (!plan) throw toolNotFoundError(name);
    const answer = definition.tools?.[name]?.answer;
    if (answer?.from === "saved") {
      const realTools = await real.listTools({ signal: ctx.mcpReq.signal });
      const answered = answerItself({
        tool: resolveMockTools(definition, realTools).tools.find(
          (tool) => tool.name === name
        ),
        name,
        answer,
        input: request.params.arguments ?? {},
        realHasTool: realTools.some((tool) => tool.name === plan.realName),
        observer,
      });
      if (answered) return answered;
    }
    return forwardCall(c, name, plan, ctx, request.params._meta?.progressToken);
  });
}

/** Refuses a forward of any other method, as a JSON-RPC error, when the host does not allow it. */
export async function assertRequestForward(
  c: ToolHandlerContext,
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
