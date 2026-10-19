import { Host } from '../src/host-config/host';
import { canonicalizeHostConfigV2 } from '../src/host-config/canonicalize';
import type { HostConfigInputV2 } from '../src/host-config/types';

const automatic = { source: { publisher: 'OpenAI', catalogEntryId: 'catalog-entry', revision: '2026-10-01:digest', sourceUrl: 'https://platform.claude.com/docs/en/release-notes/system-prompts/overview' } };
const input: HostConfigInputV2 = {
  hostStyle: 'claude', modelId: 'test-model', systemPrompt: 'Saved text',
  temperature: 0.7, requireToolApproval: false, serverIds: [], optionalServerIds: [],
  connectionDefaults: { headers: {}, requestTimeout: 30000 }, clientCapabilities: {}, hostContext: {},
};

describe('saved automatic system prompts', () => {
  it('preserves source and empty eligibility through Host JSON copies', () => {
    for (const record of [automatic, {}]) {
      const host = new Host({ style: 'claude', model: 'test-model', systemPrompt: 'Saved text', systemPromptDefault: record });
      expect(new Host(host.toJSON()).toJSON().systemPromptDefault).toEqual(record);
      host.setSystemPrompt('Saved text');
      expect(host.toJSON().systemPromptDefault).toBeUndefined();
    }
  });
  it('preserves legacy bytes and appends normalized metadata for backend parity', () => {
    const base = canonicalizeHostConfigV2(input);
    expect(base).not.toHaveProperty('systemPromptDefault');
    expect(canonicalizeHostConfigV2({ ...input, systemPromptDefault: automatic })).toEqual({ ...base, systemPromptDefault: automatic });
    expect(canonicalizeHostConfigV2({ ...input, systemPromptDefault: {} })).toEqual({ ...base, systemPromptDefault: {} });
  });
});
