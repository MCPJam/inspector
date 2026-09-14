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
   * Record that a value was typed into the document `documentKey` names
   * (`tabId|performance.timeOrigin`). Keyed by document, not URL, so pushState
   * and fragment changes keep it exposed; a missing key means exposure
   * everywhere for the rest of the boot.
   */
  markTyped(documentKey: string | undefined): void;
  /**
   * Could a registered value still be on the document `documentKey` names?
   * An unknown key answers yes once anything has been typed.
   */
  exposedAt(documentKey: string | undefined): boolean;
  /** Has anything been typed at all? Lets callers skip reading documents. */
  hasExposure(): boolean;
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
  /** Documents a value has been typed into. @see markTyped */
  const typedInto = new Set<string>();
  /** A typing that could not be placed in a document. @see markTyped */
  let typedSomewhere = false;

  return {
    register(secrets) {
      for (const secret of secrets) {
        // Too short to scrub; the planner and substitution refuse these first.
        if (secret.value.length < MIN_SCRUBBABLE_LENGTH) continue;
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
    markTyped(documentKey) {
      if (documentKey) typedInto.add(documentKey);
      else typedSomewhere = true;
    },
    exposedAt(documentKey) {
      if (typedSomewhere) return true;
      if (typedInto.size === 0) return false;
      return !documentKey || typedInto.has(documentKey);
    },
    hasExposure() {
      return typedSomewhere || typedInto.size > 0;
    },
    get size() {
      return byValue.size;
    },
  };
}
