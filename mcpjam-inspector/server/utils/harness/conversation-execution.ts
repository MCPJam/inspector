import { getManagerConnections } from "../mcp-connections.js";
import type { MCPClientManager } from "@mcpjam/sdk";
import { resolveAgentLoop, hasAccountRouting } from './agent-loop-dispatch.js';
import type { Harness } from '@mcpjam/sdk/host-config/internal';
import type { ExecutionScope } from '../execution-scope.js';

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
