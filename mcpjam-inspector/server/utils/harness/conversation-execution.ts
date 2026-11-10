import { getManagerConnections } from "../mcp-connections.js";
import type { MCPClientManager } from "@mcpjam/sdk";
import { resolveAgentLoop, hasAccountRouting } from './agent-loop-dispatch.js';
import type { Harness } from '@mcpjam/sdk/host-config/internal';
import type { ExecutionScope } from '../execution-scope.js';
import { startEarly, type EarlyStart } from '../early-start.js';

export async function assertConversationExecution(args: {
  projectId: string;
  mcpClientManager?: MCPClientManager;
  origin?: 'playground' | 'mcpjam_agent' | 'scenario';
  executionBindingVersion?: 1;
  chatSessionId?: string;
  scenarioId?: string;
  executionScope?: ExecutionScope;
  authHeader?: string;
  agentLoop?: Harness;
  harness?: Harness;
  signal?: AbortSignal;
}): Promise<void> {
  if (args.executionBindingVersion !== 1 && !args.agentLoop) return;
  if (!args.chatSessionId || !args.projectId || !args.authHeader) {
    if (args.agentLoop) throw new Error('Sign in and start a new chat to use this client.');
    return;
  }
  const binding = resolveAgentLoop({
    agentLoop: args.agentLoop,
    hasAccountRouting: args.mcpClientManager ? hasAccountRouting(getManagerConnections(args.mcpClientManager)) : false,
    harness: args.agentLoop ? undefined : args.harness,
  });
  const token = args.authHeader.replace(/^Bearer\s+/i, '').trim();
  const response = await fetch(new URL('/web/chat/execution-binding', process.env.CONVEX_HTTP_URL), {
    method: 'POST', signal: args.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      projectId: args.projectId, chatSessionId: args.chatSessionId,
      origin: args.origin, scenarioId: args.scenarioId, executionScope: args.executionScope, binding,
    }),
  });
  if (!response.ok) {
    throw new Error('This conversation cannot continue with the selected runtime. Start a new chat.');
  }
}

type ConversationExecutionArgs = Parameters<typeof assertConversationExecution>[0];

/** The fields a turn persists under that decide its binding check. */
export type ConversationExecutionScope = Pick<
  ConversationExecutionArgs,
  'projectId' | 'chatSessionId' | 'scenarioId' | 'executionBindingVersion' |
  'executionScope' | 'harness' | 'agentLoop'
>;

/**
 * The binding check's arguments, built from what the turn persists under, so
 * the route's early check and the stream's own check ask the same question.
 */
export function conversationExecutionArgs(input: {
  manager?: MCPClientManager;
  scope: ConversationExecutionScope;
  authHeader?: string;
  signal?: AbortSignal;
}): ConversationExecutionArgs {
  const { scope } = input;
  return {
    mcpClientManager: input.manager,
    projectId: scope.projectId, chatSessionId: scope.chatSessionId,
    origin: scope.scenarioId ? 'scenario' : 'playground',
    executionBindingVersion: scope.executionBindingVersion,
    scenarioId: scope.scenarioId, executionScope: scope.executionScope,
    harness: scope.harness, agentLoop: scope.agentLoop,
    authHeader: input.authHeader, signal: input.signal,
  };
}

/**
 * Start the check now when the backend says the row `bind` would check for
 * this direct conversation (which may be a teammate's shared row) is already
 * bound: `bind` then only validates that binding. Anything else (a new chat, a
 * fork onto a fresh id, an unbound row, a backend that does not say) may
 * create or patch a row, so it keeps its serial place after the box and a turn
 * refused before then pins nothing. A scenario turn binds a different row,
 * which `executionBound` does not describe, so it always keeps its serial
 * place.
 */
export function startBoundConversationExecutionCheck(
  executionBound: boolean,
  args: ConversationExecutionArgs,
): EarlyStart<void> | undefined {
  return executionBound && args.scenarioId === undefined
    ? startEarly(() => assertConversationExecution(args))
    : undefined;
}
