import assert from 'node:assert';
import { describe, it } from 'node:test';

import { SlackContextError, slackContextFrom, tenantKey, tryslackContextFrom } from '../../agent/slack-context.js';

describe('slackContextFrom', () => {
  it('reads the tenant and actor from Bolt context', () => {
    const ctx = slackContextFrom({ context: { teamId: 'T1', userId: 'U1' } });
    assert.deepStrictEqual(ctx, { teamId: 'T1', slackUserId: 'U1' });
  });

  it('falls back to the event body for interactive payloads', () => {
    // Block-action payloads carry the team under `body.team.id` and the
    // clicker under `body.user.id`; Bolt's context is not always populated.
    const ctx = slackContextFrom({ body: { team: { id: 'T2' }, user: { id: 'U2' } } });
    assert.deepStrictEqual(ctx, { teamId: 'T2', slackUserId: 'U2' });
  });

  it('reads the event itself when neither context nor body carries the team', () => {
    const ctx = slackContextFrom({ event: { team: 'T3', user: 'U3' } });
    assert.deepStrictEqual(ctx, { teamId: 'T3', slackUserId: 'U3' });
  });

  it('uses the installing team from authorizations for shared channels', () => {
    // The real shape of a Slack Connect event: `event.team` is the workspace
    // the MESSAGE came from, which is NOT the workspace that installed us.
    // Acting on `event.team` would look up an installation we do not have and
    // run the turn as the wrong tenant, so the authorization must win.
    const ctx = slackContextFrom({
      body: {
        team_id: 'T_OTHER',
        authorizations: [{ team_id: 'T_INSTALLED' }],
      },
      event: { team: 'T_OTHER', user: 'U9' },
    });
    assert.strictEqual(ctx.teamId, 'T_INSTALLED');
  });

  it('the installing authorization outranks Bolt context too', () => {
    const ctx = slackContextFrom({
      context: { teamId: 'T_CTX', userId: 'U_CTX' },
      body: { authorizations: [{ team_id: 'T_INSTALLED' }] },
    });
    assert.strictEqual(ctx.teamId, 'T_INSTALLED');
  });

  it('prefers Bolt context over body when no authorization is present', () => {
    const ctx = slackContextFrom({
      context: { teamId: 'T_CTX', userId: 'U_CTX' },
      body: { team_id: 'T_BODY', user: { id: 'U_BODY' } },
    });
    assert.deepStrictEqual(ctx, { teamId: 'T_CTX', slackUserId: 'U_CTX' });
  });

  it('throws rather than guessing when the team is absent', () => {
    assert.throws(() => slackContextFrom({ context: { userId: 'U1' } }), SlackContextError);
  });

  it('throws rather than guessing when the actor is absent', () => {
    assert.throws(() => slackContextFrom({ context: { teamId: 'T1' } }), SlackContextError);
  });

  it('tryslackContextFrom returns null instead of throwing', () => {
    assert.strictEqual(tryslackContextFrom({}), null);
    assert.deepStrictEqual(tryslackContextFrom({ context: { teamId: 'T1', userId: 'U1' } }), {
      teamId: 'T1',
      slackUserId: 'U1',
    });
  });
});

describe('tenantKey', () => {
  it('namespaces a key by workspace', () => {
    assert.strictEqual(tenantKey({ teamId: 'T1' }, 'C1:42.0'), 'T1:C1:42.0');
  });

  it('produces distinct keys for the same channel in two workspaces', () => {
    assert.notStrictEqual(tenantKey({ teamId: 'T1' }, 'C1:42.0'), tenantKey({ teamId: 'T2' }, 'C1:42.0'));
  });
});
