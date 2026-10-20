import { isHarness, type Harness } from '@mcpjam/sdk/host-config/internal';
import { HARNESS_MCP_DELIVERY } from '@/shared/harness-mcp-delivery';

export type AgentLoopDispatch = {
  loop: 'mcpjam' | 'harness';
  mcpClient: 'mcpjam' | 'harness';
  harnessId?: Harness;
};

export function resolveAgentLoop(input: { agentLoop?: unknown; harness?: unknown; defaultMcpClient?: 'harness' | 'mcpjam'; hasAccountRouting?: boolean } = {}): AgentLoopDispatch {
  if (input.agentLoop !== undefined && input.harness !== undefined) {
    throw new Error('This client has two agent runtimes selected. Clear one before starting a chat.');
  }
  const id = input.agentLoop ?? input.harness;
  if (id === undefined) return { loop: 'mcpjam', mcpClient: 'mcpjam' };
  if (!isHarness(id)) throw new Error('This client has an unsupported agent runtime. Choose a supported client.');
  return {
    loop: 'harness', harnessId: id,
    mcpClient: input.agentLoop !== undefined || input.hasAccountRouting === true || (input.defaultMcpClient ?? (HARNESS_MCP_DELIVERY[id] === 'host-executed' ? 'mcpjam' : 'harness')) === 'mcpjam' ? 'mcpjam' : 'harness',
  };
}

/** A permission resume must not reroute through a different engine or billing rail. */
export function assertAgentLoopResume(agentLoop: Harness | undefined, isScopeResume: boolean): void {
  if (agentLoop && isScopeResume) {
    throw new Error('This client cannot resume this permission request yet. Start a new chat after granting access.');
  }
}


export function hasAccountRouting(groups: Record<string, readonly { key: string }[]> | undefined): boolean {
  return Object.entries(groups ?? {}).some(([serverId, group]) =>
    group.length > 1 || group.some(connection => connection.key !== serverId));
}
