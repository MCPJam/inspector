/**
 * Up/Down through what you already sent, in the chat composer (BB-183).
 *
 * The behaviour every terminal and developer tool has: press Up in the input
 * and your last message comes back, Up again for the one before it, Down to
 * walk forward. People arrive here with the reflex already trained, and today
 * the key does nothing for them.
 *
 * **Nothing is stored.** The history IS the conversation on screen — the user
 * messages the thread already holds in memory. So it cannot drift from what
 * the reader sees, it costs no query and no row, it needs no permission, and a
 * signed-out or guest tester gets it on the same terms as anyone else. The one
 * thing it does not survive is a reload that starts a blank thread, which is
 * the honest consequence of not inventing a second copy.
 */

/** A message as the composer's thread holds it — only what history reads. */
interface HistorySourceMessage {
  role?: string;
  parts?: unknown[];
}

function messageText(message: HistorySourceMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const candidate = part as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string"
        ? candidate.text
        : "";
    })
    .join("")
    .trim();
}

/**
 * The user's own messages, newest first.
 *
 * Assistant turns are not history: you cannot have typed one. Empty messages
 * (an attachment sent with no text) are skipped rather than offered as a blank
 * recall, and a message identical to the one before it collapses into a single
 * entry — resending the same prompt twice is one thing you typed, and making
 * someone press Up twice to get past their own retry is the kind of papercut
 * this feature exists to remove.
 */
export function collectInputHistory(
  messages: readonly unknown[] | undefined | null,
): string[] {
  if (!Array.isArray(messages)) return [];
  const entries: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as HistorySourceMessage | null;
    if (!message || message.role !== "user") continue;
    const text = messageText(message);
    if (!text) continue;
    if (entries[entries.length - 1] === text) continue;
    entries.push(text);
  }
  return entries;
}

/**
 * Where the walk currently stands.
 *
 * `applied` is the exact string this navigation put in the field, and it is
 * what makes "the user has since typed" detectable without watching keystrokes:
 * if the field no longer holds it, the walk is over and the next Up starts
 * again from the newest entry, stashing whatever is now there. That also covers
 * the field being cleared by a send.
 */
export interface InputHistoryNavigation {
  /** Index into the entries list — 0 is the most recent message. */
  index: number;
  /** What the field held when the walk began, returned at the newest end. */
  draft: string;
  /** The exact text this walk last placed in the field. */
  applied: string;
}

export interface NavigateInputHistoryArgs {
  direction: "older" | "newer";
  entries: readonly string[];
  /** What the field holds right now. */
  value: string;
  navigation: InputHistoryNavigation | null;
}

export interface NavigateInputHistoryResult {
  navigation: InputHistoryNavigation | null;
  value: string;
}

/**
 * One Up or Down press.
 *
 * `null` means **this key is not ours** — the caller must let the caret move
 * normally. That is the difference between a composer that can still be edited
 * and one that has swallowed the arrow keys, so every branch that has nothing
 * to offer says so rather than consuming the press.
 */
export function navigateInputHistory(
  args: NavigateInputHistoryArgs,
): NavigateInputHistoryResult | null {
  const { direction, entries, value } = args;
  // A walk the user has typed over is not a walk any more.
  const active =
    args.navigation && args.navigation.applied === value
      ? args.navigation
      : null;

  if (direction === "older") {
    if (entries.length === 0) return null;
    const nextIndex = active ? active.index + 1 : 0;
    if (nextIndex >= entries.length) {
      // Already at the oldest. A terminal stays put here; it does NOT hand the
      // key back and jump the caret somewhere unrelated.
      return active ? { navigation: active, value } : null;
    }
    const applied = entries[nextIndex]!;
    return {
      navigation: {
        index: nextIndex,
        draft: active ? active.draft : value,
        applied,
      },
      value: applied,
    };
  }

  // Down outside a walk belongs to the caret, not to us.
  if (!active) return null;
  if (active.index === 0) {
    return { navigation: null, value: active.draft };
  }
  const nextIndex = active.index - 1;
  const applied = entries[nextIndex]!;
  return {
    navigation: { index: nextIndex, draft: active.draft, applied },
    value: applied,
  };
}

/**
 * Whether an arrow press at this caret belongs to history or to the caret.
 *
 * Only at the edge: Up is history when there is no line above to move to, Down
 * when there is none below. Otherwise a multi-line draft could not be edited at
 * all — you could never reach its first line to fix a word.
 *
 * Lines here are the ones the writer typed, not the ones the box wraps into. A
 * long paragraph with no newline in it is one line by this measure, so Up from
 * the middle of it reaches history a row earlier than the eye expects.
 * Measuring wrapped rows means measuring the rendered box; the draft is handed
 * straight back by Down, so the cost of being wrong here is a surprise rather
 * than lost work.
 */
export function caretIsOnFirstLine(value: string, caret: number): boolean {
  return !value.slice(0, Math.max(0, caret)).includes("\n");
}

export function caretIsOnLastLine(value: string, caret: number): boolean {
  return !value.slice(Math.max(0, caret)).includes("\n");
}
