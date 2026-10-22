import { describe, expect, it } from 'vitest';
import { resolveAgentLoop, assertAgentLoopResume } from '../agent-loop-dispatch';

describe('agent loop dispatch', () => {
  it('keeps ordinary clients on the MCPJam loop', () => {
    expect(resolveAgentLoop()).toEqual({ loop: 'mcpjam', mcpClient: 'mcpjam' });
  });
  it.each(['claude-code', 'codex'] as const)('runs %s with the selected MCPJam client', agentLoop => {
    expect(resolveAgentLoop({ agentLoop })).toEqual({ loop: 'harness', mcpClient: 'mcpjam', harnessId: agentLoop });
    expect(() => assertAgentLoopResume(agentLoop, true)).toThrow('cannot resume');
    expect(() => assertAgentLoopResume(agentLoop, false)).not.toThrow();
  });
  it('preserves existing CLI client delivery', () => {
    expect(resolveAgentLoop({ harness: 'claude-code' }).mcpClient).toBe('harness');
    expect(resolveAgentLoop({ harness: 'cursor' }).mcpClient).toBe('harness');
    expect(resolveAgentLoop({ harness: 'codex' }).mcpClient).toBe('mcpjam');
  });
  it('refuses unknown or conflicting selectors instead of falling back', () => {
    expect(() => resolveAgentLoop({ agentLoop: 'missing' })).toThrow('unsupported');
    expect(() => resolveAgentLoop({ harness: 'missing' })).toThrow('unsupported');
    expect(() => resolveAgentLoop({ harness: 'claude-code', agentLoop: 'codex' })).toThrow('two agent runtimes');
  });
});
