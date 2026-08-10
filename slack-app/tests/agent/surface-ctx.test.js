import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toSurfaceCtx } from '../../agent/surface-ctx.js';

describe('toSurfaceCtx', () => {
  it('maps teamId/slackUserId to tenantId/actorId', () => {
    assert.deepEqual(toSurfaceCtx({ teamId: 'T1', slackUserId: 'U1' }), {
      tenantId: 'T1',
      actorId: 'U1',
    });
  });

  it('carries isLegacyWorkspace through as isLegacyTenant, only when true', () => {
    assert.deepEqual(toSurfaceCtx({ teamId: 'T1', slackUserId: 'U1', isLegacyWorkspace: true }), {
      tenantId: 'T1',
      actorId: 'U1',
      isLegacyTenant: true,
    });
    assert.deepEqual(toSurfaceCtx({ teamId: 'T1', slackUserId: 'U1', isLegacyWorkspace: false }), {
      tenantId: 'T1',
      actorId: 'U1',
    });
  });
});
