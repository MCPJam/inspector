/**
 * `{{secret:NAME}}` — letting a model log in without ever seeing the password.
 *
 * ## What is wrong today
 *
 * A model with a browser and a credential types the credential. Literally, as
 * a string, in a tool call. That value then lands in:
 *
 *   - the tool-call ARGUMENTS, persisted verbatim in the transcript;
 *   - the accessibility tree that comes straight back, because
 *     `a11y-render.ts` renders `node.value`;
 *   - the ledger row, the eval trace, the swarm stream events;
 *   - and the model's own context, where it will be re-read on every
 *     subsequent step of the turn.
 *
 * So the model has to be TOLD the secret in order to use it, which is the one
 * thing the materialized-secret machinery exists to avoid everywhere else.
 *
 * ## The shape of the fix
 *
 * The model writes a PLACEHOLDER — `{{secret:GITHUB_PASSWORD}}` — and never
 * learns the value. The server plans (here), the daemon substitutes at the last
 * moment, and what comes back is scrubbed to the same placeholder.
 *
 * THIS MODULE DOES NOT SUBSTITUTE. It reads an action, says which names it
 * references and whether each is usable, and refuses the ones that are not. The
 * substitution happens in the daemon, against values that travel OUTSIDE the
 * command envelope — which is what keeps the ledger row, `/v1/trace` and the
 * durable mirror plaintext-free by construction rather than by scrubbing.
 *
 * ## Why a fixed syntax and not a nonce
 *
 * Nothing here has to be unguessable: the placeholder is written by the model
 * and read by the daemon, and a model that wanted to type a literal
 * `{{secret:X}}` into a page has no security reason to be stopped. What it has
 * to be is REASONABLE TO THE MODEL — it is a name the model is thinking about,
 * the same argument `harness/external-account-credentials.ts` makes for its own
 * fixed spelling.
 *
 * There is deliberately NO ESCAPE for a literal `{{secret:...}}`. A model that
 * genuinely needs to type that string into a page cannot, and that is a
 * documented limitation rather than an oversight: an escape syntax is a second
 * thing to get right in a security-relevant parser, to serve a case nobody has.
 */

/** The backend's own charset for a secret name. @see convex-secrets-client */
const NAME = "[A-Z_][A-Z0-9_]*";

/**
 * Every `{{secret:NAME}}` in a string.
 *
 * A factory: the regex carries `g`, and a shared global regex's `lastIndex`
 * survives between calls and silently skips the first match of every other
 * string it is given.
 */
const placeholderPattern = () => new RegExp(`\\{\\{secret:(${NAME})\\}\\}`, "g");

/** Every secret name referenced by `text`, in order of first appearance. */
export function secretNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(placeholderPattern())) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/** Does this string reference any secret at all? */
export function hasSecretPlaceholder(text: string): boolean {
  return placeholderPattern().test(text);
}

/**
 * Substitute every placeholder, given the values.
 *
 * EVERY OCCURRENCE, and inside a longer string: `user-{{secret:SUFFIX}}` is a
 * real thing a model writes, and a `type` by ref REPLACES the whole field, so
 * a prefix and a secret cannot be composed by two separate acts.
 *
 * Returns `null` when any placeholder has no value, so the caller can refuse
 * rather than type a literal `{{secret:NAME}}` into somebody's login form.
 */
export function substituteSecrets(
  text: string,
  values: ReadonlyMap<string, string>,
): string | null {
  let missing = false;
  const out = text.replace(placeholderPattern(), (whole, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      missing = true;
      return whole;
    }
    return value;
  });
  return missing ? null : out;
}

/** Why a placeholder cannot be used. @see planSecretPlaceholders */
export type SecretPlaceholderRefusal =
  /** No secret by that name is available to this turn. */
  | "secret_unknown"
  /**
   * The name exists, but its value never enters this process.
   *
   * A brokered secret is injected at the egress transform, so there is nothing
   * here to type. Its own code because the fix is different: the user has to
   * switch that secret to materialized delivery, which is a decision with
   * consequences, not a typo in a name.
   */
  | "secret_not_typeable"
  /** A placeholder on a verb that does not type anything. */
  | "secret_verb_refused";

export interface SecretPlan {
  /** The `{name, value}` pairs to send beside the command. */
  deliver: Array<{ name: string; value: string }>;
  /** The first refusal, when the plan cannot go ahead. */
  refusal?: {
    code: SecretPlaceholderRefusal;
    /** NAMES ONLY — never a value, and never a guess at one. */
    message: string;
  };
}

/** The verbs that put text into a page. Everything else refuses. */
const TYPING_VERBS: ReadonlySet<string> = new Set(["type", "fill_form"]);

/**
 * Read an act, and say what has to travel with it.
 *
 * Refuses rather than silently passing a placeholder through, on all three
 * failure shapes, because every one of them ends with a literal
 * `{{secret:NAME}}` typed into a real field on a real site:
 *
 *  - an unknown name (a typo, a secret in another environment);
 *  - a BROKERED name, whose value is injected at the egress transform and
 *    never enters this process at all;
 *  - a placeholder on a verb that types nothing — `click`, `press`, `scroll`.
 *    A `press {{secret:X}}` is asking for a KEY NAME, and substituting a
 *    password there would send several hundred unknown keystrokes.
 */
export function planSecretPlaceholders(args: {
  verb: string;
  value?: string;
  fields?: ReadonlyArray<{ value?: string }>;
  /** Materialized secrets this turn actually has. */
  available: ReadonlyArray<{ name: string; value: string }>;
  /**
   * Names that exist for this environment but are BROKERED.
   *
   * Separate from `available` so the refusal can say which of the two problems
   * it is; a caller that cannot find out passes nothing and every unusable
   * name reads as unknown, which is the safe direction.
   */
  brokered?: ReadonlyArray<string>;
}): SecretPlan {
  const texts = [
    ...(args.value === undefined ? [] : [args.value]),
    ...(args.fields ?? []).flatMap((field) =>
      field.value === undefined ? [] : [field.value],
    ),
  ];
  const referenced: string[] = [];
  for (const text of texts) {
    for (const name of secretNamesIn(text)) {
      if (!referenced.includes(name)) referenced.push(name);
    }
  }
  if (referenced.length === 0) return { deliver: [] };

  if (!TYPING_VERBS.has(args.verb)) {
    return {
      deliver: [],
      refusal: {
        code: "secret_verb_refused",
        message:
          `secret_verb_refused: a {{secret:...}} placeholder only works on ` +
          `\`type\` and \`fill_form\`, not on \`${args.verb}\`. Use \`type\` to ` +
          "put a credential in a field.",
      },
    };
  }

  const byName = new Map(args.available.map((s) => [s.name, s.value]));
  const brokered = new Set(args.brokered ?? []);
  for (const name of referenced) {
    if (byName.has(name)) continue;
    if (brokered.has(name)) {
      return {
        deliver: [],
        refusal: {
          code: "secret_not_typeable",
          message:
            `secret_not_typeable: "${name}" is delivered to this environment's ` +
            "network requests rather than to the browser, so it cannot be " +
            "typed into a page. Switch it to materialized delivery if a form " +
            "needs it.",
        },
      };
    }
    return {
      deliver: [],
      refusal: {
        code: "secret_unknown",
        message:
          `secret_unknown: no secret named "${name}" is available to this ` +
          "turn. Check the name, and that it is set for this environment.",
      },
    };
  }

  // ONLY THE REFERENCED ONES. Sending this turn's whole secret set with every
  // command would put values on the wire that the command has no use for — and
  // the daemon registers what it is sent, so it would also start scrubbing
  // observations for credentials nobody typed.
  return {
    deliver: referenced.map((name) => ({ name, value: byName.get(name)! })),
  };
}
