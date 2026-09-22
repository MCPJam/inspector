/**
 * Handle feedback button interactions.
 * @param {import('@slack/bolt').AllMiddlewareArgs & import('@slack/bolt').SlackActionMiddlewareArgs<import('@slack/bolt').BlockFeedbackButtonsAction>} args
 * @returns {Promise<void>}
 */
export async function handleFeedbackButton({ ack, body, client, context, logger }) {
  await ack();

  try {
    const userId = /** @type {string} */ (context.userId);
    const channelId = /** @type {string} */ (body.channel?.id);
    const messageTs = /** @type {string} */ (body.message?.ts);
    const feedbackValue = body.actions[0].value;

    if (feedbackValue === 'good-feedback') {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: messageTs,
        text: 'Glad that was helpful! :tada:',
      });
    } else {
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        thread_ts: messageTs,
        text: "Sorry that wasn't helpful. :slightly_frowning_face: Try rephrasing your question and I'll give it another shot.",
      });
    }

    logger.debug(`Feedback received: value=${feedbackValue}, message_ts=${messageTs}`);
  } catch (e) {
    logger.error(`Failed to handle feedback: ${e}`);
  }
}
