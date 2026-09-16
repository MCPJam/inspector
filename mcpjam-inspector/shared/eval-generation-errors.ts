/**
 * Generation failures the UI has to tell apart, by their message.
 *
 * The generation stream carries an error as a STRING, not a code, so the page
 * that renders it can only recognise a failure by the text the server threw.
 * Keeping both messages here means the server's copy and the client's test for
 * it cannot drift apart silently — a reworded message that only one side knew
 * about is how "Retry generation" ended up offered for a failure retrying
 * could never fix.
 */

/**
 * The selected scope asks for read-only tools and this snapshot has none.
 *
 * DETERMINISTIC: the same request fails the same way every time, because
 * nothing about it depends on the model. Retrying is not a way out — changing
 * the scope, or annotating the tools, is.
 */
export const NO_READ_ONLY_TOOLS_MESSAGE =
  "No tools are marked read-only on these servers. Choose Read and write or add read-only tool annotations, then try again.";

/**
 * The model produced cases, but none stayed inside the read-only scope.
 *
 * Retrying CAN work here: which cases come back is model-dependent, so this is
 * a different failure from the one above despite naming the same setting.
 */
export const NO_READ_ONLY_CASES_MESSAGE =
  "No read-only cases matched the selected scope. Try generating again or choose Read and write.";

/**
 * True when re-sending the SAME request cannot succeed, so the only honest
 * offer is to change the settings rather than to try again.
 */
export function isUnretryableGenerationScope(
  message: string | undefined,
): boolean {
  return message === NO_READ_ONLY_TOOLS_MESSAGE;
}
