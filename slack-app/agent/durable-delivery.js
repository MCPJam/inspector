import { WebClient } from '@slack/web-api';
import { backend, fetchInstallationRecord, hasBackendConfig } from '../installations/backend-client.js';
import { buildCreatedResourceBlocks } from '../listeners/views/agent-reply-builder.js';
import { buildFeedbackBlocks } from '../listeners/views/feedback-builder.js';
import { buildProposalBlocks, rendersRunProposalFor } from '../listeners/views/proposal-builder.js';

/** Updating a saved message handle is safe to repeat after a lost response.
 * @param {import('@slack/web-api').WebClient} client
 * @param {{channel:string,ts:string}} handle
 * @param {any} result
 */
export async function deliverDurableReply(client, handle, result) {
  const reply = result.reply || 'Done — though I have nothing to add.';
  await client.chat.update({
    channel: handle.channel,
    ts: handle.ts,
    text: reply,
    blocks: /** @type {any} */ ([
      { type: 'section', text: { type: 'mrkdwn', text: reply.slice(0, 2900) } },
      ...buildCreatedResourceBlocks(result.createdResources ?? [], {
        suiteAccessory: (resource) => !rendersRunProposalFor(result.proposedActions ?? [], resource),
      }),
      ...buildProposalBlocks(result.proposedActions ?? []),
      ...buildFeedbackBlocks(),
    ]),
  });
  if (result.jobId) {
    try {
      await backend.post('/slack/turns/delivered', { jobId: result.jobId });
    } catch {
      // The reply is already delivered. Recovery retries this saved handle
      // until the backend acknowledges it; do not post a failure reply.
    }
  }
}

/** @param {{error:Function}} logger */
export function startDurableDeliveryRecovery(logger) {
  if (!hasBackendConfig()) return;
  let running = false;
  const recover = async () => {
    if (running) return;
    running = true;
    try {
      const { deliveries } = await backend.post('/slack/turns/pending', {});
      for (const delivery of deliveries) {
        try {
          const record = await fetchInstallationRecord(delivery.teamId);
          const token = /** @type {any} */ (record?.installation)?.bot?.token;
          if (!token) continue;
          await deliverDurableReply(new WebClient(token), delivery.replyHandle, {
            ...delivery.result,
            jobId: delivery.jobId,
          });
        } catch (error) {
          logger.error(`Could not recover agent reply: ${error}`);
        }
      }
    } catch (error) {
      logger.error(`Could not read pending agent replies: ${error}`);
    } finally {
      running = false;
    }
  };
  void recover();
  const timer = setInterval(() => {
    void recover();
  }, 15000);
  timer.unref();
}
