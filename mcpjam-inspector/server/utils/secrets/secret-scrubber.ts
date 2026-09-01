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
  /**
   * Replace every registered value inside an ALREADY-SERIALIZED JSON document.
   *
   * Distinct from `scrubString` because the raw form of a value must NOT be
   * searched here. Inside serialized JSON, real string content is escaped, so
   * a genuine occurrence appears in its escaped form and the raw form can only
   * match by coincidence — including against the document's own punctuation.
   * A value of `","foo":` matches `{"a":"","foo":"x"}` structurally and
   * replacing it yields invalid JSON, corrupting a payload that never
   * contained the secret at all.
   */
  scrubSerializedJson(input: string): string;
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
  secrets: readonly SecretRegistryEntry[]
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

  // Each secret contributes its raw form plus one form per level of JSON
  // escaping it can pick up on the way into a document.
  //
  // ONE LEVEL IS NOT ENOUGH, and this is the case that motivated the depth
  // loop. A tool result that is ITSELF a JSON string already holds the value in
  // escaped form; serializing the surrounding payload escapes it a second time.
  // A value `abcdefgh"i` reaches the transcript as `abcdefgh\\\"i`, and the
  // once-escaped needle `abcdefgh\"i` is not a substring of that — the two
  // backslashes never sit next to the quote the way the needle expects. So a
  // credential containing a quote, a backslash or a newline survived inside
  // nested JSON, and surfaced intact the moment the outer document was parsed.
  //
  // Depths are generated by re-escaping until the form stops changing, and the
  // stopping rule is the INPUT, not a constant. A fixed cap is a cliff: a value
  // nested one level past it survives whole, because each escaped form is a
  // distinct string that contains none of the shallower ones as a substring —
  // the backslash run in front of the escaped character doubles every level, so
  // the shallower needle never lines up. A depth-3 cap left exactly that hole
  // at depth 4.
  //
  // The bound that has no cliff is the haystack itself: a needle longer than
  // the string being searched cannot occur in it. So forms are generated only
  // while they still fit, which both closes the hole and keeps a value with no
  // special characters on the single-needle path it was already on.
  //
  // The ceiling is a guard against a pathological input, not the working limit;
  // forms double in length each level, so it is unreachable for any real
  // payload.
  const ESCAPE_DEPTH_CEILING = 32;
  function escapedForms(value: string, maxLength: number): string[] {
    const forms: string[] = [];
    let current = value;
    for (let depth = 0; depth < ESCAPE_DEPTH_CEILING; depth++) {
      const next = JSON.stringify(current).slice(1, -1);
      // Escaping is identity for this value: the raw form is the only form.
      if (next === current) break;
      // Longer than anything it could be found inside.
      if (next.length > maxLength) break;
      forms.push(next);
      current = next;
    }
    return forms;
  }

  type Needle = { search: string; replace: string };

  // LONGEST FIRST, now across escape depths rather than just across secrets. A
  // deeper form is strictly longer than a shallower one and contains it as a
  // near-substring, so replacing the shallow form first would leave the deep
  // one partially rewritten — the same failure the entry sort above prevents
  // between overlapping secrets.
  const byLongestSearch = (a: Needle, b: Needle): number =>
    b.search.length - a.search.length;

  function buildNeedleLists(maxLength: number): {
    all: Needle[];
    /**
     * The escaped-only set, for scrubbing a document that is ALREADY serialized
     * JSON. Searching the raw form there cannot find real content — it is
     * escaped by definition — and can match the document's structure instead.
     */
    json: Needle[];
  } {
    const all: Needle[] = [];
    const json: Needle[] = [];
    for (const entry of entries) {
      const replace = replacementFor(entry.name);
      all.push({ search: entry.value, replace });
      // Whether escaping is IDENTITY for this value is a different question
      // from whether its escaped forms fit: a value with no special characters
      // is its own escaped form and the JSON set needs it, whereas a value
      // whose forms were all too long to fit simply cannot occur here, and
      // adding its raw form would reintroduce the structural false match the
      // JSON set exists to avoid.
      if (JSON.stringify(entry.value).slice(1, -1) === entry.value) {
        json.push({ search: entry.value, replace });
        continue;
      }
      for (const form of escapedForms(entry.value, maxLength)) {
        json.push({ search: form, replace });
        all.push({ search: form, replace });
      }
    }
    all.sort(byLongestSearch);
    json.sort(byLongestSearch);
    return { all, json };
  }

  // `scrubDeep` calls `scrubString` once per string leaf, so the lists are
  // memoised rather than rebuilt per call. The key is the input length rounded
  // UP to a power of two: rounding up can only generate forms too long to
  // match, never too few to find one, and it holds the cache to a couple of
  // dozen entries no matter how many distinct payload sizes go through.
  const listCache = new Map<number, { all: Needle[]; json: Needle[] }>();
  function needleListsFor(inputLength: number): {
    all: Needle[];
    json: Needle[];
  } {
    const bucket =
      inputLength <= 1 ? 1 : 2 ** Math.ceil(Math.log2(inputLength));
    const cached = listCache.get(bucket);
    if (cached) return cached;
    const built = buildNeedleLists(bucket);
    listCache.set(bucket, built);
    return built;
  }

  function applyNeedles(input: string, list: readonly Needle[]): string {
    let out = input;
    for (const needle of list) {
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

  function scrubString(input: string): string {
    return applyNeedles(input, needleListsFor(input.length).all);
  }

  function scrubSerializedJson(input: string): string {
    // Keep the JSON envelope's own field names intact. A secret can legally be
    // named/valued `chatSessionId`, `projectId`, or another control key; a raw
    // global replacement would delete that metadata and make the persisted
    // ingest body unusable. Parse valid JSON and scrub its values (and nested
    // keys) while preserving only the top-level envelope keys. Bounded prefixes
    // are intentionally not valid JSON, so retain the escaped-needle fallback
    // for those fragments.
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return applyNeedles(input, needleListsFor(input.length).json);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return applyNeedles(input, needleListsFor(input.length).json);
    }
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      Object.defineProperty(out, key, {
        value: scrubDeep(value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return JSON.stringify(out);
  }

  /**
   * Depth cap and cycle guard, so this is safe on a RAW payload.
   *
   * It did not need them while it only ever ran on a value that
   * `boundPayload` had already depth-capped — that pass turned a cycle into a
   * marker before the scrubber saw it. Once scrubbing moved BEFORE bounding
   * (so a credential cannot straddle the truncation cut), that protection was
   * gone and a cyclic or pathologically deep payload from a third-party MCP
   * server would recurse until the stack blew, turning a turn that used to
   * succeed into a 500.
   *
   * The cap matches `chat-session-payloads`'s `MAX_DEPTH` deliberately: the two
   * passes now run back to back on the same value, and a scrubber that gave up
   * shallower would leave string leaves unscrubbed that bounding would happily
   * keep.
   */
  const MAX_SCRUB_DEPTH = 8;
  /**
   * Stand-ins for content this pass refuses to descend into. Deliberately
   * spelled like the bounding pass's own markers, because that is exactly what
   * they mean to a reader of the payload: something was here and was dropped.
   */
  const DEPTH_MARKER = "[truncated: max depth]";
  const CYCLE_MARKER = "[truncated: circular reference]";

  function scrubDeepInner<T>(value: T, depth: number, seen: Set<object>): T {
    if (typeof value === "string") {
      return scrubString(value) as unknown as T;
    }
    // THE INVARIANT: this function never returns content it did not scrub.
    //
    // Both of the guards below originally handed the RAW value back — the
    // obvious way to stop recursing. That is wrong for a scrubber, and
    // measurably so at the cycle guard: a back-reference sits at some depth
    // below the cap, so returning the original object spliced an UNSCRUBBED
    // subtree into the scrubbed result. Serialization then walked it, and a
    // credential inside it reached the output. Relying on the caller's later
    // pass to catch that is not enough either — if the payload is oversized,
    // the cut can land mid-credential and no needle matches a fragment.
    //
    // Markers instead. They also make the result acyclic and shallow, so the
    // bounding pass that runs next cannot rediscover either problem.
    //
    // PRIMITIVES ARE EXEMPT, and the ordering here is the whole of it. A
    // number, boolean or null cannot recurse and cannot hide a credential, so
    // the depth cap has nothing to protect against — capping one replaced real
    // tool data with the marker STRING, changing both the value and its type.
    // Strings are already handled above, where they are scrubbed rather than
    // capped, for the same reason: the cap exists to stop descent, and a leaf
    // is not a descent.
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_SCRUB_DEPTH) return DEPTH_MARKER as unknown as T;
    if (Array.isArray(value)) {
      if (seen.has(value)) return CYCLE_MARKER as unknown as T;
      seen.add(value);
      const out = value.map((item) =>
        scrubDeepInner(item, depth + 1, seen)
      ) as unknown as T;
      seen.delete(value);
      return out;
    }
    if (value && typeof value === "object") {
      if (seen.has(value as object)) return CYCLE_MARKER as unknown as T;
      // Preserve non-plain objects (Date, Uint8Array, …) by identity: they hold
      // no string leaves worth rewriting, and rebuilding them as plain objects
      // would corrupt the payload far more than a missed scrub would.
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return value;
      seen.add(value as object);
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(
        value as Record<string, unknown>
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
          value: scrubDeepInner(item, depth + 1, seen),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      seen.delete(value as object);
      return out as unknown as T;
    }
    return value;
  }

  function scrubDeep<T>(value: T): T {
    return scrubDeepInner(value, 0, new Set<object>());
  }

  return { scrubString, scrubSerializedJson, scrubDeep, size: entries.length };
}
