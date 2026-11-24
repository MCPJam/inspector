/**
 * A failure's message as one sentence, to sit between what failed and what
 * to do next. The API's refusals end in a full stop; a network failure's
 * message does not.
 */
export function sentenceOf(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
