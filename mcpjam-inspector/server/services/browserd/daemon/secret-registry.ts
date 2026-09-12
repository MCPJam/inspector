/**
 * The values this boot has typed into a page, and what to show instead.
 *
 * A secret typed into a form does not stay in the form. It comes back in the
 * accessibility tree (`a11y-render.ts` renders `node.value`), in the page text,
 * in the DOM signal, in a console line the page logged, and in the URL after a
 * GET submit. Substituting at the last moment keeps it off the WIRE; this is
 * what keeps it out of everything the page hands back afterwards.
 *
 * ## Why it is per-BOOT and not per-command
 *
 * Once a value has been typed, it is in the page — and the page will keep
 * showing it for as long as the session lasts. An observation three commands
 * later reads the same field. So the registry is retained for the boot's
 * lifetime: forgetting after the command that typed it would scrub exactly one
 * observation and leak every subsequent one.
 *
 * The daemon is a per-session process on a box the model's own shell cannot
 * reach (a different `runtimeKind`), so "for the boot" is the same lifetime the
 * browser profile already has.
 *
 * ## What it deliberately does not do
 *
 * It is not populated at boot, ever. Only a command that CARRIED a secret puts
 * one here, so a daemon nobody has typed a credential into holds nothing and
 * every observation costs exactly what it costs today.
 */
import {
  createSecretScrubber,
  MIN_SCRUBBABLE_LENGTH,
  type SecretScrubber,
} from "../../../../shared/secret-scrubber";

export interface BrowserSecretRegistry {
  /** Remember a value typed into this session's browser. */
  register(secrets: ReadonlyArray<{ name: string; value: string }>): void;
  /**
   * A scrubber over everything registered, or `null` when nothing is.
   *
   * `null` rather than a no-op so the caller writes `scrubber ? … : value` and
   * the overwhelmingly common path — a session with no secrets — does no work
   * and allocates nothing.
   */
  scrubber(): SecretScrubber | null;
  /**
   * Values too SHORT for the scrubber, with their names.
   *
   * The scrubber refuses anything under {@link MIN_SCRUBBABLE_LENGTH} because
   * replacing a four-character value everywhere would corrupt unrelated text —
   * a page that says "test" would come back as a placeholder. But a short
   * value typed into a FIELD is still a secret, and the a11y renderer knows
   * something a text scrubber cannot: that a `value` is the whole contents of
   * one control, so an exact match there is not a coincidence.
   */
  maskedValues(): ReadonlyMap<string, string>;
  /**
   * Remember that a value was typed into the page showing `url`.
   *
   * THE PAGE, not the session. A value typed into a form is on screen for
   * exactly as long as that form is, and the screenshot suppression this feeds
   * has to lift when the page moves on — a login flow where every picture
   * after the password field is blank would be a worse agent, not a safer one.
   *
   * An empty or absent `url` means the typing could not be attributed to a
   * page, and is treated as exposure everywhere for the rest of the boot: it
   * happens only when the act that carried the secret could not read the page
   * it typed into, and "somewhere" is the only honest answer then.
   */
  markTyped(url: string | undefined): void;
  /**
   * Could a registered value still be rendered on the page at `url`?
   *
   * `undefined` — a result that carried no URL — answers the same as an
   * unattributable typing: yes, if anything has been typed at all. A capture
   * nobody can place is a capture nobody can clear.
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
          // THE PLACEHOLDER THE MODEL WROTE, not `[secret:NAME]`. The value was
          // typed on purpose, through a placeholder the model chose; giving it
          // back the same spelling means the tree it reads afterwards says
          // exactly what it asked for, and it can carry on reasoning about the
          // field without ever learning the value.
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
      // A result with no URL is placed nowhere, so nothing can say the page it
      // shows is not the page a value was typed into.
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
