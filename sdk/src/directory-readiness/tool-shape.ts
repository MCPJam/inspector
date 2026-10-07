/**
 * What a tool's SCHEMA says about whether it reads, writes, or both.
 *
 * Publisher-neutral and shared on purpose. Anthropic forbids a tool that does
 * both; Meta's Muse allows one but requires it to be classified as a write.
 * Those are two different rules over ONE observation — "this tool's own schema
 * enumerates a read verb and a write verb" — and two copies of the detector
 * would eventually disagree about which tools that observation covers, at
 * which point the same server would be "combined" for one publisher and not
 * the other.
 *
 * Pure: reads an input schema, dials nothing.
 */

/**
 * Verbs that read, and verbs that change things.
 *
 * Deliberately short and unambiguous. A longer list catches more real cases
 * and also more false ones, and a false "this tool does both" accuses a
 * submitter of a design flaw they do not have.
 */
const SAFE_VERBS = ["get", "list", "read", "search", "query", "fetch", "find"];
const UNSAFE_VERBS = [
  "create",
  "update",
  "delete",
  "write",
  "remove",
  "insert",
  "upsert",
  "send",
  "post",
  "put",
  "patch",
  "execute",
  "drop",
];

interface SchemaLike {
  type?: unknown;
  enum?: unknown;
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

/** The fields of a tool this module reads. Shape-compatible with every publisher's tool type. */
export interface ToolShapeEvidence {
  inputSchema?: unknown;
}

export function asSchema(value: unknown): SchemaLike | undefined {
  return typeof value === "object" && value !== null
    ? (value as SchemaLike)
    : undefined;
}

function matchesVerb(value: string, verbs: string[]): boolean {
  const normalized = value.toLowerCase();
  return verbs.some(
    (verb) =>
      normalized === verb ||
      normalized.startsWith(`${verb}_`) ||
      normalized.startsWith(`${verb}-`) ||
      // `getUser`, `createOrder` — camelCase, but only at the START, so
      // `budget` does not match `get` and `deleted_at` does not match
      // `delete`. A direct character test rather than a `new RegExp` built on
      // every comparison.
      (normalized.startsWith(verb) && /[A-Z]/.test(value.charAt(verb.length)))
  );
}

/** One enumerated operation parameter that offers both a read and a write. */
export interface DemonstrableReadWriteVerbs {
  parameter: string;
  safe: string[];
  unsafe: string[];
}

/**
 * A tool whose schema DEMONSTRABLY accepts both a safe and an unsafe verb.
 *
 * "Demonstrably" is the whole rule, and it is narrow on purpose. The only
 * evidence that settles this from a schema alone is an ENUMERATED set of
 * operations containing verbs from both sides: the server has itself written
 * down that this one tool does `list` and `delete`. Anything looser — a
 * free-string `method`, a name like `manage_records`, a description that
 * mentions deleting — is a guess, and a hard failure built on a guess tells a
 * submitter to redesign their API on our hunch.
 */
export function demonstrableReadWriteVerbs(
  tool: ToolShapeEvidence
): DemonstrableReadWriteVerbs | undefined {
  const properties = asSchema(tool.inputSchema)?.properties;
  if (!properties) return undefined;

  for (const [parameter, rawSchema] of Object.entries(properties)) {
    const schema = asSchema(rawSchema);
    const values = schema?.enum;
    if (!Array.isArray(values)) continue;
    const strings = values.filter(
      (value): value is string => typeof value === "string"
    );
    const safe = strings.filter((value) => matchesVerb(value, SAFE_VERBS));
    const unsafe = strings.filter((value) => matchesVerb(value, UNSAFE_VERBS));
    if (safe.length > 0 && unsafe.length > 0) {
      return { parameter, safe, unsafe };
    }
  }
  return undefined;
}
