/**
 * Server-name chips as the group picker draws them, and the rule that decides
 * how many fit on one line. Shared so every surface that lists a group's
 * servers looks like what the user picked.
 */

/** `muted`, not the Badge's `secondary`: the lighter of two near-whites. */
export const CHIP =
  "rounded-full border-transparent bg-muted px-2 py-0 text-[11px] font-normal text-muted-foreground";

/**
 * Roughly what a chip occupies, in pixels. Measured in the app at 11px: the
 * flat 22 is padding plus gap, then 5.2px a latin character and 11.5px a wide
 * one. Counting characters alone cut a two-chip row with 42px free; charging
 * them equally let two CJK names in and wrapped it.
 *
 * `[...text]` so a surrogate pair counts once. A formula, not a measurement —
 * swap in a real one only if a font change makes it wrong enough to wrap.
 */
const WIDE =
  /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]|[\u{1F300}-\u{1FAFF}]|[\u{20000}-\u{3FFFD}]/u;

export const chipWidth = (text: string) =>
  22 + [...text].reduce((w, ch) => w + (WIDE.test(ch) ? 11.5 : 5.2), 0);

/**
 * As many chips as FIT in `roomPx`, not a fixed count: a fixed count wrapped
 * the row. Each candidate must leave room for the `+N` that would follow it,
 * and the first chip always shows, however wide.
 */
export function fitChips(
  names: readonly string[],
  roomPx: number,
): { shown: string[]; hidden: string[] } {
  const shown: string[] = [];
  let used = 0;
  for (const [i, name] of names.entries()) {
    const hidden = names.length - i - 1;
    const next = used + chipWidth(name);
    if (
      shown.length > 0 &&
      next + (hidden > 0 ? chipWidth(`+${hidden}`) : 0) > roomPx
    ) {
      break;
    }
    shown.push(name);
    used = next;
  }
  return { shown, hidden: names.slice(shown.length) };
}
