/**
 * What a successful send leaves in the composer. Typed after the sent text, at
 * a word boundary → the rest; untouched → empty; edited or a continued last
 * word → unchanged, since that is the user's new draft.
 */
export function remainingText(current: string, sent: string): string {
  if (current === sent) return "";
  if (!current.startsWith(sent)) return current;
  const atBoundary =
    sent === "" || /\s$/.test(sent) || /\s/.test(current[sent.length]);
  return atBoundary ? current.slice(sent.length).trimStart() : current;
}

/** The items the send did not carry, compared by identity. */
export function withoutSent<T>(current: readonly T[], sent: readonly T[]): T[] {
  return current.filter((item) => !sent.includes(item));
}
