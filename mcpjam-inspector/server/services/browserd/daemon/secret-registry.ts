/**
 * Values this boot has typed into a page, and what to show instead.
 *
 * A typed secret comes back in the a11y tree, page text, DOM, console and URLs,
 * and stays in the page for the rest of the session, so the registry lives for
 * the whole boot. Only commands that carried a secret populate it.
 */
import {
  createSecretScrubber,
  MIN_SCRUBBABLE_LENGTH,
  type SecretScrubber,
} from "../../../../shared/secret-scrubber";

export interface BrowserSecretRegistry {
  /** Remember a value typed into this session's browser. */
  register(secrets: ReadonlyArray<{ name: string; value: string }>): void;
  /** A scrubber over everything registered, or `null` (no work) when empty. */
  scrubber(): SecretScrubber | null;
  /**
   * Values too short for the text scrubber. The a11y renderer masks an exact
   * match on a control's whole `value`, which cannot be a coincidence.
   */
  maskedValues(): ReadonlyMap<string, string>;
  /**
   * Record that a value was typed into the page at `url`. Screenshot
   * suppression is per page so it lifts on navigation; a missing `url` counts
   * as exposure everywhere for the rest of the boot.
   */
  markTyped(url: string | undefined): void;
  /**
   * Could a registered value still be on the page at `url`? An unknown URL
   * answers yes if anything has been typed.
   */
  exposedAt(url: string | undefined): boolean;
  /** How many values are registered — for tests and diagnostics. */
  readonly size: number;
}

/** What a registered value is replaced by. @see substituteSecrets */
const placeholderFor = (name: string) => `{{secret:${name}}}`;

export function createBrowserSecretRegistry(): BrowserSecretRegistry {
  /** By VALUE, so the same credential under two names registers once. */
  const byValue = new Map<string, string>();
  let scrubber: SecretScrubber | null = null;
  let stale = false;
  /** URLs a value has been typed into. @see markTyped */
  const typedInto = new Set<string>();
  /** A typing that could not be placed on a page. @see markTyped */
  let typedSomewhere = false;

  return {
    register(secrets) {
      for (const secret of secrets) {
        if (!secret.value) continue;
        if (byValue.get(secret.value) === secret.name) continue;
        byValue.set(secret.value, secret.name);
        stale = true;
      }
    },
    scrubber() {
      if (stale) {
        scrubber = createSecretScrubber(
          [...byValue].map(([value, name]) => ({ name, value })),
          // Give back the placeholder the model wrote, never the value.
          { replacement: placeholderFor },
        );
        stale = false;
      }
      return scrubber;
    },
    markTyped(url) {
      if (url) typedInto.add(url);
      else typedSomewhere = true;
    },
    exposedAt(url) {
      if (typedSomewhere) return true;
      if (typedInto.size === 0) return false;
      return url === undefined || url === "" || typedInto.has(url);
    },
    maskedValues() {
      const short = new Map<string, string>();
      for (const [value, name] of byValue) {
        if (value.length < MIN_SCRUBBABLE_LENGTH) {
          short.set(value, placeholderFor(name));
        }
      }
      return short;
    },
    get size() {
      return byValue.size;
    },
  };
}
