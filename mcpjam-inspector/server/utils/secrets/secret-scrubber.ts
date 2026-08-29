/**
 * Keeping a MATERIALIZED secret's value out of the transcript.
 *
 * ## Why the existing redactor is not enough
 *
 * `log-scrubber.ts` redacts by KEY NAME (`authorization`, `api_key`, …) and by
 * VALUE SHAPE (`sk-…`, `Bearer …`). Both are pattern guesses, and a project
 * secret is by definition a value we KNOW — so guessing is the wrong tool.
 *
 * More importantly, chat-session tool payloads are UNREDACTED BY DESIGN. The
 * header of `chat-session-payloads.ts` says so plainly: an agent debugging its
 * own MCP server needs the arguments it sent and the result it got back, and a
 * prose summary is not the deliverable. That is right, and it is exactly why
 * materialized delivery needs this: the moment a real credential is an
 * environment variable inside the box, `env`, a shell echo, or a tool that
 * reflects its own configuration will put it into a payload that is then
 * persisted verbatim, forever.
 *
 * ## What this does, and what it does not
 *
 * It replaces EXACT KNOWN VALUES — the `{name, value}` pairs this turn actually
 * fetched, already in memory, costing no extra decrypt — with `[secret:NAME]`.
 * It is not a heuristic and does not try to be: an unregistered string is never
 * touched, so the payload surface stays as honest as it was.
 *
 * It is also a SECOND line of defence, not the first. The first is brokered
 * delivery, where the value never enters the box at all. Materialized delivery
 * is extractable by design — a determined agent can base64 the value, split it
 * across two tool calls, or paste it into a file it then reads back — and no
 * post-hoc scrubber can fix that. What this fixes is the ACCIDENTAL case, which
 * is overwhelmingly the common one: a command that echoes its environment, a
 * client that logs its own headers, a stack trace carrying a connection string.
 *
 * Brokered values never reach this process at all, so there is nothing here for
 * them to miss.
 */

/** One registered value, and the name it is replaced by. */
export type SecretRegistryEntry = { name: string; value: string };

/**
 * Values shorter than this are NOT registered.
 *
 * A short secret is not a secret worth this trade: replacing every occurrence
 * of, say, a four-character value would corrupt unrelated text throughout the
 * transcript — a tool result mentioning `test` would come back as
 * `[secret:MY_KEY]` — and a transcript that lies about what a tool returned is
 * worse than one carrying a low-entropy value the user chose to materialize.
 * The threshold is the same order as the shortest credential any real API
 * issues.
 */
export const MIN_SCRUBBABLE_LENGTH = 8;

export type SecretScrubber = {
  /** Replace every registered value inside one string. */
  scrubString(input: string): string;
  /**
   * Replace every registered value in the STRING LEAVES of a JSON-ish value.
   * Arrays and objects are rebuilt; non-string leaves pass through untouched.
   */
  scrubDeep<T>(value: T): T;
  /** How many values are registered — for tests and diagnostics only. */
  readonly size: number;
};

function replacementFor(name: string): string {
  return `[secret:${name}]`;
}

/**
 * Build a scrubber, or `null` when there is nothing to scrub.
 *
 * `null` rather than a no-op object so every call site is forced to write
 * `scrubber ? scrubber.scrubDeep(x) : x` — which costs nothing on the
 * overwhelmingly common path where a session has no materialized secrets, and
 * makes "this turn has secrets" visible in the code rather than hidden inside a
 * function that usually does nothing.
 */
export function createSecretScrubber(
  secrets: readonly SecretRegistryEntry[],
): SecretScrubber | null {
  // LONGEST FIRST. If two secrets overlap — one value a prefix or substring of
  // another, which happens when a token and a `Bearer <token>` form are both
  // registered — replacing the shorter one first would leave the longer one
  // partially rewritten and therefore partially INTACT in the transcript.
  const entries = secrets
    .filter((entry) => entry.value.length >= MIN_SCRUBBABLE_LENGTH)
    .slice()
    .sort((a, b) => b.value.length - a.value.length);
  if (entries.length === 0) return null;

  // Each secret contributes two search forms:
  //   1. the RAW value, which is what appears in a live response object;
  //   2. its JSON-ESCAPED body, which is what appears once the value has been
  //      serialized into a string — a tool that returns its config as a JSON
  //      string, or any payload we scrub after `JSON.stringify`. A value
  //      containing a quote, a backslash or a newline looks nothing like itself
  //      in that form, and searching only for the raw text would sail past it.
  const needles: { search: string; replace: string }[] = [];
  for (const entry of entries) {
    const replace = replacementFor(entry.name);
    needles.push({ search: entry.value, replace });
    const escaped = JSON.stringify(entry.value).slice(1, -1);
    if (escaped !== entry.value) {
      needles.push({ search: escaped, replace });
    }
  }

  function scrubString(input: string): string {
    let out = input;
    for (const needle of needles) {
      // `split`/`join` rather than `replace`: a `String.replace` with a string
      // pattern replaces only the FIRST occurrence, and its replacement string
      // expands `$&` / `$1` patterns — so a credential containing `$&` would be
      // re-expanded into the output. Neither trap applies here.
      if (out.includes(needle.search)) {
        out = out.split(needle.search).join(needle.replace);
      }
    }
    return out;
  }

  function scrubDeep<T>(value: T): T {
    if (typeof value === "string") {
      return scrubString(value) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => scrubDeep(item)) as unknown as T;
    }
    if (value && typeof value === "object") {
      // Preserve non-plain objects (Date, Uint8Array, …) by identity: they hold
      // no string leaves worth rewriting, and rebuilding them as plain objects
      // would corrupt the payload far more than a missed scrub would.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>,
      )) {
        // KEYS ARE SCRUBBED TOO. The tempting rule is that a key is a field
        // name rather than a payload, so no producer would ever build one out
        // of a credential — but the producers here are third-party MCP servers,
        // and "no server does that" is not a property this process can assert
        // about code it did not write. A tool that groups results by API key,
        // echoes a request header map, or dumps a cache keyed by token puts the
        // credential in key position, and an unscrubbed key reaches the
        // transcript in plaintext, which is the exact leak this module exists
        // to prevent.
        //
        // A key holding no registered value is returned by `scrubString`
        // unchanged and re-assigned identically, so ordinary payloads keep
        // their exact shape. Two keys can only collide after scrubbing if both
        // contain the secret and differ ONLY inside it; the later wins, as it
        // would for a duplicate key anywhere else in JS. Losing that key is a
        // strictly better outcome than publishing the credential.
        // `defineProperty`, not `out[key] = …`. A payload with an own
        // `__proto__` key is legal JSON and a third-party MCP server can emit
        // one; plain assignment hands it to the prototype SETTER instead of
        // creating a property, so the field vanishes from the output and the
        // result silently stops being a plain object — which would then make
        // the `proto !== Object.prototype` guard above skip it wholesale on any
        // later pass. `defineProperty` treats every key as data.
        Object.defineProperty(out, scrubString(key), {
          value: scrubDeep(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out as unknown as T;
    }
    return value;
  }

  return { scrubString, scrubDeep, size: entries.length };
}
