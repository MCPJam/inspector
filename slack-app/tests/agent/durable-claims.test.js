import assert from 'node:assert';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { dedupe, runTurnForEvent } from '../../agent/turn-runner.js';
import { InstallationBackendError } from '../../installations/backend-client.js';

const CTX = { teamId: 'T1', slackUserId: 'U1', isLegacyWorkspace: true };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * A fake backend: a claim table plus the agent endpoint. Records every agent
 * call so a test can assert the turn ran (or did not) and with which key.
 */
function stubBackend({ claimOutcomes = [], agentStatus = 200, agentErrorBody } = {}) {
  const state = { claims: new Map(), agentCalls: [], claimCalls: [], releases: [] };
  let outcomeIndex = 0;

  globalThis.fetch = mock.fn(async (url, init) => {
    const path = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};

    if (path.endsWith('/slack/claims/claim')) {
      state.claimCalls.push(body.dedupeKey);
      // Scripted outcomes let a test force the inflight/completed branches.
      const forced = claimOutcomes[outcomeIndex++];
      if (forced) return jsonResponse({ ok: true, ...forced });
      const existing = state.claims.get(body.dedupeKey);
      if (existing) {
        return jsonResponse({
          ok: true,
          outcome: existing.status === 'done' ? 'completed' : 'inflight',
          resultEnvelope: existing.resultEnvelope ?? null,
        });
      }
      state.claims.set(body.dedupeKey, { status: 'inflight' });
      return jsonResponse({ ok: true, outcome: 'claimed', resultEnvelope: null });
    }
    if (path.endsWith('/slack/claims/complete')) {
      state.claims.set(body.dedupeKey, {
        status: 'done',
        resultEnvelope: body.resultEnvelope,
      });
      return jsonResponse({ ok: true, completed: true });
    }
    if (path.endsWith('/slack/claims/release')) {
      state.releases.push(body.dedupeKey);
      state.claims.delete(body.dedupeKey);
      return jsonResponse({ ok: true, released: true });
    }
    if (path.includes('/agent')) {
      state.agentCalls.push({
        idempotencyKey: body.idempotencyKey,
        header: init?.headers?.['x-mcpjam-idempotency-key'],
      });
      return jsonResponse(
        agentStatus === 200
          ? { reply: 'here is your suite', toolCalls: [], createdResources: [{ id: 'ts_1' }] }
          : (agentErrorBody ?? { code: 'INTERNAL_ERROR', message: 'boom' }),
        agentStatus,
      );
    }
    throw new Error(`unexpected fetch to ${path}`);
  });
  return state;
}

const slackClient = /** @type {any} */ ({
  conversations: { history: async () => ({ messages: [{ ts: '1.0', user: 'U1', text: 'hello' }] }) },
});

function triggerArgs(overrides = {}) {
  return {
    client: slackClient,
    ctx: CTX,
    channelId: 'D1',
    threadTs: '100.0',
    triggerTs: '100.0',
    eventId: 'Ev123',
    isThread: false,
    botUserId: 'B1',
    fallbackText: 'hi',
    onResult: async () => {},
    ...overrides,
  };
}

describe('durable event claims', () => {
  /** @type {typeof fetch} */
  let realFetch;

  beforeEach(() => {
    dedupe.clear();
    process.env.MCPJAM_API_KEY = 'sk_test';
    process.env.MCPJAM_PROJECT_ID = 'p1';
    process.env.MCPJAM_BASE_URL = 'https://api.test';
    process.env.MCPJAM_CONVEX_HTTP_URL = 'https://backend.test';
    process.env.SLACK_SERVICE_TOKEN = 'svc_test';
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.MCPJAM_CONVEX_HTTP_URL;
    delete process.env.SLACK_SERVICE_TOKEN;
  });

  it('claims on the Slack event id, not the channel+ts', async () => {
    // The event id is the identity of the DELIVERY CHAIN — a redelivery
    // carries it unchanged, which is exactly what the claim needs.
    const state = stubBackend();
    await runTurnForEvent(triggerArgs());
    assert.deepStrictEqual(state.claimCalls, ['T1:Ev123']);
  });

  it('passes the SAME key to the turn so the server can derive write keys', async () => {
    const state = stubBackend();
    await runTurnForEvent(triggerArgs());
    assert.strictEqual(state.agentCalls[0].idempotencyKey, 'T1:Ev123');
  });

  it('replays the stored reply for a redelivery instead of re-running', async () => {
    // This is the whole point of storing the envelope: the alternatives are
    // losing the answer or authoring a second suite.
    const state = stubBackend();
    const replays = [];

    await runTurnForEvent(triggerArgs());
    assert.strictEqual(state.agentCalls.length, 1);

    // A redelivery after a restart: the in-memory registry is empty.
    dedupe.clear();
    const ran = await runTurnForEvent(triggerArgs({ onReplay: async (envelope) => replays.push(envelope) }));

    assert.strictEqual(ran, false, 'redelivery must not report as a fresh turn');
    assert.strictEqual(state.agentCalls.length, 1, 'the turn must NOT re-run');
    assert.strictEqual(replays.length, 1);
    assert.strictEqual(replays[0].reply, 'here is your suite');
    assert.deepStrictEqual(replays[0].createdResources, [{ id: 'ts_1' }]);
  });

  it('suppresses a delivery whose claim is already in flight elsewhere', async () => {
    const state = stubBackend({ claimOutcomes: [{ outcome: 'inflight', resultEnvelope: null }] });
    const ran = await runTurnForEvent(triggerArgs());
    assert.strictEqual(ran, false);
    assert.strictEqual(state.agentCalls.length, 0);
  });

  it('FAILS CLOSED when the claim backend is unreachable', async () => {
    // Treating an unreachable backend as "you own it" would turn one Slack
    // event into two billed turns — the exact failure the claim prevents.
    globalThis.fetch = mock.fn(async (url) =>
      String(url).includes('/claims/')
        ? jsonResponse({ error: 'down' }, 503)
        : jsonResponse({ reply: 'should never be reached' }),
    );
    await assert.rejects(runTurnForEvent(triggerArgs()), InstallationBackendError);
  });

  it('a claim-backend failure leaves the event re-runnable', async () => {
    // The in-memory claim must be released, or the retry against a healthy
    // process would be swallowed as a duplicate and the user would get
    // nothing at all.
    globalThis.fetch = mock.fn(async () => jsonResponse({ error: 'down' }, 503));
    await assert.rejects(runTurnForEvent(triggerArgs()));

    const state = stubBackend();
    const ran = await runTurnForEvent(triggerArgs());
    assert.strictEqual(ran, true);
    assert.strictEqual(state.agentCalls.length, 1);
  });

  it('releases the claim when the pre-turn hook fails', async () => {
    // No turn work happened, so the event must stay processable.
    const state = stubBackend();
    await assert.rejects(
      runTurnForEvent(
        triggerArgs({
          onStart: async () => {
            throw new Error('slack status down');
          },
        }),
      ),
      /slack status down/,
    );
    assert.deepStrictEqual(state.releases, ['T1:Ev123']);
    assert.strictEqual(state.agentCalls.length, 0);
  });

  it('COMPLETES a dispatched-but-failed turn with a failure envelope — never releases', async () => {
    // "No Slack reply" is not "no side effects": once the turn request reached
    // the network, the server may have persisted a suite before failing (its
    // error contract says exactly this). Releasing would let a redelivery
    // RE-RUN the turn — and a stochastic retry can author different arguments,
    // sail past the derived idempotency keys, and create a second suite. So
    // the claim is finished with a failure envelope; retrying is a HUMAN
    // decision that arrives as a new event.
    const state = stubBackend({ agentStatus: 500 });
    await assert.rejects(runTurnForEvent(triggerArgs()));
    assert.deepStrictEqual(state.releases, [], 'a dispatched turn must never be released');
    assert.strictEqual(state.claims.get('T1:Ev123')?.status, 'done');
    const envelope = state.claims.get('T1:Ev123')?.resultEnvelope;
    assert.ok(envelope?.reply?.length > 0, 'the failure message is what redeliveries replay');
    assert.deepStrictEqual(envelope?.toolCalls, []);

    // A redelivery replays the failure — the agent is NOT re-run.
    dedupe.clear();
    const replayed = [];
    const ran = await runTurnForEvent(triggerArgs({ onReplay: async (env) => replayed.push(env.reply) }));
    assert.strictEqual(ran, false);
    assert.strictEqual(replayed.length, 1);
    assert.strictEqual(state.agentCalls.length, 1, 'one dispatch, ever, for this event');
  });

  it('a failed turn carries its persisted resources into the failure envelope', async () => {
    // The server attaches `details.createdResources` to a failed turn that
    // already persisted a suite. Discarding them is how "failed" comes to be
    // read as "nothing happened" — and how the user gets told to start over on
    // a suite that exists.
    const state = stubBackend({
      agentStatus: 500,
      agentErrorBody: {
        code: 'INTERNAL_ERROR',
        message: 'engine fell over',
        details: {
          createdResources: [
            { type: 'eval_suite', id: 'ts_1', name: 'Half-born suite', url: 'https://app.test/evals/suite/ts_1' },
          ],
        },
      },
    });
    await assert.rejects(runTurnForEvent(triggerArgs()));
    const envelope = state.claims.get('T1:Ev123')?.resultEnvelope;
    assert.strictEqual(envelope?.createdResources?.length, 1);
    assert.strictEqual(envelope?.createdResources?.[0]?.id, 'ts_1');
  });

  it('RELEASES on a local preflight failure (CONFIG) even though dispatch was marked', async () => {
    // `runAgentTurn` resolves credentials BEFORE any fetch. A config error is
    // provably pre-network — finalizing it would replay "it failed" for 72
    // hours after the operator fixed the environment.
    const state = stubBackend();
    delete process.env.MCPJAM_API_KEY;
    await assert.rejects(runTurnForEvent(triggerArgs()), /MCPJAM_API_KEY/);
    assert.deepStrictEqual(state.releases, ['T1:Ev123']);
    assert.strictEqual(state.claims.has('T1:Ev123'), false);
    assert.strictEqual(state.agentCalls.length, 0);
  });

  it('RELEASES when the failure happened before the turn was ever dispatched', async () => {
    // Pre-dispatch failures (context fetch, credential resolution) provably
    // have no server-side work behind them; holding the claim would silence
    // the event for the full TTL over a transient Slack hiccup.
    const state = stubBackend();
    const args = triggerArgs({
      client: /** @type {any} */ ({
        conversations: {
          history: async () => {
            throw new Error('slack context fetch down');
          },
        },
      }),
    });
    await assert.rejects(runTurnForEvent(args), /slack context fetch down/);
    assert.deepStrictEqual(state.releases, ['T1:Ev123']);
    assert.strictEqual(state.agentCalls.length, 0);

    // And the release is real: a redelivery re-claims and runs.
    dedupe.clear();
    const rerun = stubBackend();
    await runTurnForEvent(triggerArgs());
    assert.strictEqual(rerun.agentCalls.length, 1);
  });

  it('COMPLETES the claim when the turn ran but delivering it failed', async () => {
    // The mirror image of the test above, and the distinction is the whole
    // point: the turn RAN, so it has already been billed. Releasing here would
    // let a redelivery buy the same answer twice; leaving it `inflight` would
    // sit on the answer until the TTL sweep and give the user nothing. So the
    // claim is finished with the answer the user was owed.
    const state = stubBackend();
    await assert.rejects(
      runTurnForEvent(
        triggerArgs({
          onResult: async () => {
            throw new Error('slack post failed');
          },
        }),
      ),
      /slack post failed/,
    );
    assert.deepStrictEqual(state.releases, [], 'a turn that ran must never be released');
    assert.strictEqual(state.claims.get('T1:Ev123')?.status, 'done');
    assert.strictEqual(state.claims.get('T1:Ev123')?.resultEnvelope?.reply, 'here is your suite');

    // And a redelivery REPLAYS it — the agent is not called a second time.
    dedupe.clear();
    const replayed = [];
    const ran = await runTurnForEvent(triggerArgs({ onReplay: async (envelope) => replayed.push(envelope.reply) }));
    assert.strictEqual(ran, false);
    assert.deepStrictEqual(replayed, ['here is your suite']);
    assert.strictEqual(state.agentCalls.length, 1, 'the redelivery must not re-run the turn');
  });

  it('still surfaces the delivery failure when the claim cannot be completed', async () => {
    // Completing is best-effort: a backend blip on the way out must not
    // replace the error the caller actually needs to see and log.
    const state = stubBackend();
    const inner = globalThis.fetch;
    globalThis.fetch = mock.fn(async (url, init) =>
      String(url).endsWith('/slack/claims/complete') ? jsonResponse({ error: 'backend down' }, 503) : inner(url, init),
    );
    await assert.rejects(
      runTurnForEvent(
        triggerArgs({
          onResult: async () => {
            throw new Error('slack post failed');
          },
        }),
      ),
      /slack post failed/,
    );
    assert.deepStrictEqual(state.releases, []);
  });

  it('falls back to channel+ts when the payload carries no event id', async () => {
    const state = stubBackend();
    await runTurnForEvent(triggerArgs({ eventId: undefined }));
    assert.deepStrictEqual(state.claimCalls, ['T1:D1:100.0']);
  });

  it('keeps identical event ids from different workspaces independent', async () => {
    const state = stubBackend();
    await runTurnForEvent(triggerArgs());
    dedupe.clear();
    await runTurnForEvent(triggerArgs({ ctx: { ...CTX, teamId: 'T2' } }));
    assert.deepStrictEqual(state.claimCalls, ['T1:Ev123', 'T2:Ev123']);
    assert.strictEqual(state.agentCalls.length, 2, 'the second workspace must not be suppressed');
  });
});
