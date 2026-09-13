/**
 * `{{secret:NAME}}`: lets a model type a credential without seeing it.
 *
 * A literal credential in a tool call lands in the transcript, the a11y tree,
 * the ledger and the model's context. Instead the model writes a placeholder,
 * the server plans here, and the daemon substitutes at the last moment against
 * values sent outside the command envelope, so the ledger, `/v1/trace` and the
 * mirror never hold plaintext. Output is scrubbed back to the placeholder.
 *
 * The syntax is fixed rather than a nonce (it need not be unguessable), and
 * there is intentionally no escape for a literal `{{secret:...}}`.
 */

/** The backend's own charset for a secret name. @see convex-secrets-client */
const NAME = "[A-Z_][A-Z0-9_]*";

/**
 * Every `{{secret:NAME}}` in a string. A factory because a shared `g` regex
 * keeps `lastIndex` between calls.
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
 * Substitute every placeholder, including inside longer strings. Returns `null`
 * if any has no value, so the caller refuses instead of typing the literal.
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
  /** Brokered: the value is injected at egress and never enters this process. */
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
 * Read an act and say which secrets must travel with it. Refuses unknown
 * names, brokered names and non-typing verbs rather than passing a placeholder
 * through, which would type a literal `{{secret:NAME}}` into a real site.
 */
export function planSecretPlaceholders(args: {
  verb: string;
  value?: string;
  fields?: ReadonlyArray<{ value?: string }>;
  /** Materialized secrets this turn actually has. */
  available: ReadonlyArray<{ name: string; value: string }>;
  /**
   * Names that exist but are brokered, so the refusal can say which problem it
   * is. Omitted means every unusable name reads as unknown (the safe side).
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

  // Only referenced secrets go on the wire; the daemon registers and scrubs
  // everything it is sent.
  return {
    deliver: referenced.map((name) => ({ name, value: byName.get(name)! })),
  };
}
