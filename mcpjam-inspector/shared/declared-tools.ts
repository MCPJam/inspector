/**
 * DECLARED TOOLS — tools a party other than MCPJam declares, turned into
 * model-facing tools without letting the declarer choose what the model sees.
 *
 * MCPJam has three sources of "tools something declared at us", each with its
 * own pipeline today: the Ask MCPJam agent's curated `ui_*` catalog, the
 * SEP-1865 `app_*` aliases an MCP app iframe advertises, and the WebMCP tools a
 * real third-party PAGE registers. They already share a descriptor shape —
 * `ui-tools-registry.ts` calls itself "WebMCP-shaped" — and they already need
 * the same five things done to them: a model-safe NAME, a description that says
 * where it came from, a schema that survives the trip intact, arguments checked
 * before anything runs, and a stable hash so a consumer can tell "the same set"
 * from "a new set".
 *
 * This module is those five things, and nothing else. It is deliberately:
 *
 *   - PURE. No imports but types, so the browserd daemon can bundle it (the
 *     daemon computes the same tool-set hash the server compares) and the
 *     client can compute the same names the server minted, without either
 *     pulling in `ai`, `zod` or a validator dependency.
 *   - POLICY-FREE. It never decides whether a tool may be advertised, whether a
 *     call needs approval, or who executes it. Those differ per namespace —
 *     `ui_*` is first-party and curated, a page tool is third-party code on a
 *     signed-in browser — and folding them in here is how one namespace's
 *     relaxation silently becomes another's.
 *
 * Only the agent-browser page-tool path uses it today. It is written general
 * because the `ui_*`/`app_*` builders are meant to move onto it once the browser
 * path has proven itself, not because anything shares it yet.
 *
 * THE THREAT MODEL, stated once. A declarer chooses its tools' names,
 * descriptions and schemas, and a page is hostile by default. So:
 *
 *   - a name is SANITIZED into the model-facing charset and prefixed, so a page
 *     cannot register `Bash` or `browser_navigate` and be called;
 *   - a description is PREFIXED with a provenance header the page cannot write
 *     into (scheme + host only), and stripped of control characters, bidi
 *     overrides and the page-content fence markers — tool DEFINITIONS are not
 *     fenced, so a description is the one page-authored string that reaches the
 *     model unwrapped;
 *   - a schema is passed through VERBATIM but bounded, and arguments are checked
 *     against it here rather than trusted to the browser.
 */
import type { SerializedModelRequestTool } from "./model-request-payload";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * The model-facing name charset, from `chat-v2-orchestration`'s Anthropic /
 * Bedrock gate — which THROWS THE WHOLE TURN on a violation rather than
 * dropping the tool. WebMCP allows `.` and 128 characters, so a page name is
 * routinely outside it and every minted name has to be checked against this.
 */
export const DECLARED_TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/** Total length of a minted name, prefix included. */
export const DECLARED_TOOL_NAME_MAX_CHARS = 64;

/**
 * The prefix the agent browser's page tools carry.
 *
 * Chosen so it can never be mistaken for a CLIENT-FULFILLED namespace. Those
 * prefixes (`page_`, `ui_`, `app_`) mean "the browser supplies this result" and
 * are matched by `isClientFulfilledToolName`; a SERVER-EXECUTED tool wearing one
 * would leave the stream waiting forever on a result nobody sends. A page can
 * register a tool literally called `page_abcd1234`, which is why sanitization
 * prefixes rather than trusting the raw name.
 */
export const WEBMCP_TOOL_NAME_PREFIX = "webmcp_";

/**
 * Bound on ONE tool's input schema, in bytes of canonical JSON.
 *
 * Generous on purpose. Chrome's own imperative example is a five-branch `oneOf`
 * of `const` + `title`, and the declarative form generates an `anyOf` branch per
 * `<option>` — a country picker is legitimately hundreds of branches. The cap is
 * here so one page cannot spend a turn's whole context on a schema, not to
 * express an opinion about schema style: anything under it is advertised EXACTLY
 * as the page wrote it.
 */
export const WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES = 8_192;

/** Nesting bound, so a deeply self-similar schema cannot be walked forever. */
export const WEBMCP_TOOL_INPUT_SCHEMA_MAX_DEPTH = 12;

/** Bound on a declared description, after the provenance header. */
export const WEBMCP_TOOL_DESCRIPTION_MAX_CHARS = 1_024;

/**
 * Fence markers from `toBrowserModelOutput`, stripped out of any declarer-written
 * text.
 *
 * Tool RESULTS are fenced; tool DEFINITIONS are not (`serializeToolsForConvex`
 * passes descriptions through untouched). A page that writes an END marker into
 * its tool description is writing the one string that teaches the model "page
 * content stops here" in the one place we do not wrap — so the markers come out
 * of declarer text wherever it appears.
 */
const FENCE_MARKERS = /(?:END_)?MCPJAM_PAGE_CONTENT/g;

/**
 * C0/C1 controls except tab and newline, plus DEL.
 *
 * Built from escapes rather than written as literals: a source file carrying
 * raw control characters is one nobody can review, which is the same property
 * this expression exists to deny a page.
 */
const CONTROL_CHARS = new RegExp(
  "[\\u0000-\\u0008\\u000B-\\u001F\\u007F-\\u009F]",
  "g",
);

/**
 * Bidirectional overrides, joiners and invisible marks.
 *
 * A page that wraps its description in RLO renders text that reads one way to a
 * human reviewing the tool list and another way to the model consuming it — the
 * same trick as the Trojan Source source-code attack.
 */
const BIDI_AND_INVISIBLE = new RegExp(
  "[\\u200B-\\u200F\\u061C\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]",
  "g",
);

/**
 * Field separator for hash preimages.
 *
 * NUL, because it is the one character that cannot appear in any field it
 * joins: a tool description containing the separator would otherwise let two
 * different tool sets produce one preimage, and a hash whose whole job is to
 * say "this changed" would answer "it did not".
 */
const SEP = "\u0000";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type DeclaredToolRegistrationKind =
  "declarative" | "imperative" | "unknown";

export interface DeclaredToolAnnotations {
  readOnly?: boolean;
  untrustedContent?: boolean;
  consequential?: boolean;
  autosubmit?: boolean;
}

/**
 * One tool as its DECLARER described it. Every field is declarer-controlled
 * except the identity fields, which the observing layer mints.
 */
export interface DeclaredToolDescriptor {
  /** The name the declarer used. Arbitrary text; never model-facing as-is. */
  rawName: string;
  /** Declarer-written. Empty string when none was given. */
  description?: string;
  /** Declarer-written JSON Schema. Advertised verbatim; never rewritten. */
  inputSchema?: Record<string, unknown>;
  /** Scheme + host of the declaring document. Absent for first-party. */
  origin?: string;
  /**
   * The declaring scope, when one declarer can have several. For WebMCP this is
   * the CDP frame id: it orders collision-breaking suffixes and it is part of
   * the binding, so two same-origin duplicate iframes are two tools.
   */
  frameId?: string;
  /** The primary scope takes the un-suffixed name on a collision. */
  isMainFrame?: boolean;
  /**
   * WHICH REGISTRATION. Part of the hash and the binding, so a page that
   * unregisters and re-registers under the same name in the same frame is a NEW
   * tool rather than the old one with a new handler behind it.
   */
  registrationSeq?: number;
  registrationKind?: DeclaredToolRegistrationKind;
  annotations?: DeclaredToolAnnotations;
}

export type DeclaredToolDiagnosticCode =
  | "schema_too_large"
  | "schema_too_deep"
  | "schema_not_object"
  | "schema_unsupported_keyword"
  | "provider_unsupported"
  | "name_truncated"
  | "name_suffixed"
  /** Past `WEBMCP_MAX_PAGE_TOOLS`; not offered to the model. */
  | "over_cap";

/**
 * Something we could not do faithfully.
 *
 * A diagnostic is never silent: the Tools pane shows it beside the tool and a
 * `blocking` one keeps the tool out of the model's hands entirely. The
 * alternative — quietly altering a schema so it fits — hands the model a
 * contract the page never agreed to, which is how an invocation fails in a way
 * neither side can explain.
 */
export interface DeclaredToolDiagnostic {
  code: DeclaredToolDiagnosticCode;
  message: string;
  /** This tool cannot be advertised at all. */
  blocking?: boolean;
}

/** One tool as the MODEL will see it, plus everything needed to call it back. */
export interface MintedDeclaredTool {
  /** The model-facing name, e.g. `webmcp_add_topping`. */
  name: string;
  rawName: string;
  origin?: string;
  frameId?: string;
  isMainFrame: boolean;
  registrationSeq?: number;
  registrationKind: DeclaredToolRegistrationKind;
  /** The description the model reads: provenance header + sanitized text. */
  description: string;
  /** The declarer's schema, VERBATIM. Undefined when it had none. */
  inputSchema?: Record<string, unknown>;
  /** Digest of `inputSchema`, for change detection and the turn record. */
  schemaHash: string;
  annotations?: DeclaredToolAnnotations;
  diagnostics: DeclaredToolDiagnostic[];
}

/**
 * What a turn ADVERTISED, small enough to persist on every turn trace.
 *
 * Persisted rather than derived: the live tool set describes the page the
 * browser is on NOW, and a conversation reopened tomorrow would attribute a card
 * to whatever tool happens to carry that name then. See
 * `PersistedTurnTrace.pageToolsAtTurn`.
 */
export interface MintedPageToolRecord {
  name: string;
  rawName: string;
  origin?: string;
  schemaHash: string;
  binding?: {
    bootId: string;
    tabId: string;
    navCounter: number;
    frameId: string;
    registrationSeq: number;
  };
}

// ---------------------------------------------------------------------------
// Hashing (fnv1a/hex8 moved from client/src/lib/webmcp-inspector/page-tool-aliases.ts)
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit, run twice over the preimage with different offsets to fill
 * eight hex characters.
 *
 * Non-cryptographic on purpose and safe to be: nothing here hides anything, and
 * the two consumers that must agree — the daemon computing a tool-set hash and
 * the server comparing it — need determinism and cheapness, not collision
 * resistance against an adversary. It is also SYNCHRONOUS, which `crypto.subtle`
 * is not, and this runs inside a CDP event handler.
 */
function fnv1a(input: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // The classic FNV prime, as the shift-and-add form that stays in 32 bits.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash >>> 0;
}

/** Eight hex characters of FNV-1a over `input`. */
export function declaredToolHex8(input: string): string {
  const high = fnv1a(input, 0x811c9dc5);
  const low = fnv1a(input, 0x01000193);
  return (
    high.toString(16).padStart(8, "0").slice(0, 4) +
    low.toString(16).padStart(8, "0").slice(0, 4)
  );
}

/**
 * Canonical JSON: object keys sorted at every level, so two schemas that differ
 * only in key order hash the same. Without it a page that rebuilds its schema
 * object on every registration would look like a change on every read, and the
 * "fetch definitions only when the hash moved" optimization would never fire.
 */
function canonicalJson(
  value: unknown,
  depth = 0,
  budget: { left: number } = { left: CANONICAL_JSON_BUDGET_CHARS },
): string {
  if (depth > WEBMCP_TOOL_INPUT_SCHEMA_MAX_DEPTH * 2) return '"[deep]"';
  if (budget.left <= 0) return '"[budget]"';
  if (value === null || typeof value !== "object") {
    // A LONG STRING IS CUT BEFORE IT IS SERIALIZED, not after. `JSON.stringify`
    // on a multi-megabyte string allocates the whole escaped copy first, which
    // is exactly the work this budget exists to refuse.
    const scalar =
      typeof value === "string" && value.length > budget.left
        ? `${value.slice(0, budget.left)}…`
        : value;
    const out = JSON.stringify(scalar) ?? "null";
    budget.left -= out.length;
    return out;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (budget.left <= 0) {
        parts.push('"[budget]"');
        break;
      }
      parts.push(canonicalJson(item, depth + 1, budget));
    }
    budget.left -= parts.length + 1;
    return `[${parts.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    if (budget.left <= 0) {
      parts.push('"[budget]":0');
      break;
    }
    // THE KEY IS CUT BEFORE IT IS SERIALIZED, for the same reason the scalar
    // above is: a page can name a property as freely as it can fill one, and
    // `JSON.stringify` on a multi-megabyte key allocates the whole escaped copy
    // before any budget could be decremented — which is precisely the work this
    // budget exists to refuse.
    const encodedKey = JSON.stringify(
      key.length > budget.left ? `${key.slice(0, budget.left)}…` : key,
    );
    budget.left -= encodedKey.length + 1;
    parts.push(`${encodedKey}:${canonicalJson(record[key], depth + 1, budget)}`);
  }
  budget.left -= parts.length + 1;
  return `{${parts.join(",")}}`;
}

/**
 * How much of one schema is hashed before the walk gives up.
 *
 * A CAP ON WORK, not on meaning. `boundDeclaredSchema` already refuses to
 * ADVERTISE a schema over `WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES`, but hashing
 * happens earlier and more often — the daemon digests every revision snapshot,
 * on a heartbeat, for whatever the page registered — so a page that registers a
 * multi-megabyte string would otherwise decide how long the event loop is busy.
 *
 * Set well above the advertised cap, so every schema a model could ever see is
 * hashed in full and the budget only ever bites on schemas already destined to
 * be refused. Two schemas identical up to it collide, which costs a page that
 * declares megabytes of schema one missed refresh — not a correctness bug, and
 * a far better trade than the alternative.
 */
const CANONICAL_JSON_BUDGET_CHARS = WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES * 4;

/**
 * How many of a page's tools a turn will advertise.
 *
 * Lives HERE rather than beside the builder because the Tools pane has to
 * apply the same number: a pane listing names the model was never given, under
 * a footer saying it can call them, is a debugging surface that lies about the
 * run — and a page with a large or hostile registry is exactly when someone
 * opens it.
 */
export const WEBMCP_MAX_PAGE_TOOLS = 64;

/**
 * The one sentence for a tool past the cap — the server's drop reason and the
 * pane's diagnostic are the SAME words, so a person reading one beside the
 * other is not left wondering whether they describe the same thing.
 */
export function overCapMessage(cap: number): string {
  return (
    `this page declares more than ${cap} tools; this one is past the cap and ` +
    "is not offered to the model."
  );
}

/** Digest of one input schema. Stable across key reordering. */
export function declaredSchemaHash(
  schema: Record<string, unknown> | undefined,
): string {
  return declaredToolHex8(schema === undefined ? "" : canonicalJson(schema));
}

/**
 * A digest of an entire declared tool SET.
 *
 * Over everything the model would see or bind to: name, description, schema,
 * declaring frame and registration. Descriptions are in it because a page that
 * rewrites a tool's description has changed what the model is told the tool
 * does — a hash over names and schemas only leaves that edit invisible, and the
 * model keeps reading the previous page's wording.
 *
 * `navCounter` is folded in so a same-origin reload that re-registers an
 * IDENTICAL tool set still moves the hash: it is a different document, every
 * binding against the old one is void, and a stable hash there would tell the
 * server "nothing changed" about a page that had been replaced.
 */
export function declaredToolsHash(
  descriptors: readonly DeclaredToolDescriptor[],
  context?: { navCounter?: number },
): string {
  const rows = descriptors
    .map((descriptor) =>
      [
        descriptor.frameId ?? "",
        String(descriptor.registrationSeq ?? 0),
        descriptor.rawName,
        descriptor.description ?? "",
        declaredSchemaHash(descriptor.inputSchema),
      ].join(SEP),
    )
    .sort();
  return declaredToolHex8(
    [String(context?.navCounter ?? 0), String(rows.length), ...rows].join(SEP),
  );
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * A declarer's raw name, reduced to the model-facing charset.
 *
 * CASING IS PRESERVED. `add_topping` and `addTopping` are different names to a
 * page and lower-casing would collide them; more to the point a model reads
 * `bookSlot` and knows what it is, while `bookslot` reads like a typo. The
 * charset gate allows both cases, so there is nothing to buy by folding them.
 *
 * Hyphens SURVIVE — they are in the model-facing charset — and only runs of the
 * substituted underscore are collapsed, so `a--b` stays `a--b` while `a..b`
 * becomes `a_b` rather than `a__b`.
 *
 * An empty result (a name of nothing but punctuation) and an over-long one both
 * fall back to a digest of the ORIGINAL rather than to a shared placeholder: two
 * tools called `!!` and `??` must not become one name.
 */
export function sanitizeDeclaredToolName(
  rawName: string,
  options: { prefix?: string; maxChars?: number } = {},
): { name: string; truncated: boolean } {
  const prefix = options.prefix ?? "";
  const total = options.maxChars ?? DECLARED_TOOL_NAME_MAX_CHARS;
  const max = total - prefix.length;
  if (max <= 0) return { name: prefix.slice(0, total), truncated: true };
  const cleaned = rawName
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "");
  if (cleaned.length === 0) {
    return {
      name: `${prefix}t${declaredToolHex8(rawName)}`.slice(0, total),
      truncated: true,
    };
  }
  if (cleaned.length <= max) {
    return { name: `${prefix}${cleaned}`, truncated: false };
  }
  // TRUNCATION MUST STAY INJECTIVE. Two long names sharing a prefix would
  // otherwise become one tool, and the model would call whichever won — so the
  // tail is a digest of the WHOLE original name, not of the part we cut.
  const digest = declaredToolHex8(rawName);
  const keep = Math.max(1, max - digest.length - 1);
  return {
    name: `${prefix}${cleaned.slice(0, keep)}_${digest}`.slice(0, total),
    truncated: true,
  };
}

/**
 * Order same-named registrants: the main frame first, then by frame id.
 *
 * Deterministic without being arbitrary. The main frame is the page the user is
 * looking at and its tool is the one a model means by the bare name; among
 * subframes there is no better answer than the browser's own ids, which are at
 * least stable within a document generation — and that is what makes two
 * SAME-ORIGIN duplicate iframes (identical origin, identical tool names, and
 * nothing else to tell them apart) resolve to two distinct, stable names.
 */
function collisionOrder(
  a: DeclaredToolDescriptor,
  b: DeclaredToolDescriptor,
): number {
  if ((a.isMainFrame === true) !== (b.isMainFrame === true)) {
    return a.isMainFrame === true ? -1 : 1;
  }
  const left = a.frameId ?? "";
  const right = b.frameId ?? "";
  if (left !== right) return left < right ? -1 : 1;
  return (a.registrationSeq ?? 0) - (b.registrationSeq ?? 0);
}

/**
 * Mint model-facing names for one generation's declared tools.
 *
 * Names are recomputed per generation and stable WITHIN it: the same page, read
 * twice with nothing changed, mints the same names in the same order, so a
 * refresh between model steps does not rename a tool the model is mid-way
 * through reasoning about. Across generations they may move, which is exactly
 * why an invocation carries a binding rather than trusting its name.
 */
export function mintDeclaredToolNames(
  prefix: string,
  descriptors: readonly DeclaredToolDescriptor[],
): MintedDeclaredTool[] {
  const byBase = new Map<string, DeclaredToolDescriptor[]>();
  for (const descriptor of descriptors) {
    const { name } = sanitizeDeclaredToolName(descriptor.rawName, { prefix });
    const bucket = byBase.get(name);
    if (bucket) bucket.push(descriptor);
    else byBase.set(name, [descriptor]);
  }
  const minted: MintedDeclaredTool[] = [];
  // EVERY NAME ALREADY SPOKEN FOR, seeded with all the bases before a single
  // suffix is handed out.
  //
  // The bases are unique by construction (they are this map's keys); the
  // SUFFIXED names are not, and a page is free to declare a tool called
  // literally `foo_f1` alongside two called `foo`. Allocating `_f<k>` blind
  // would then mint `webmcp_foo_f1` twice, and two tools sharing a model-facing
  // name is the one thing this whole minting pass exists to prevent.
  const taken = new Set(byBase.keys());
  /** How many names are in play at all — the bound on the search below. */
  const total = descriptors.length;
  for (const [base, bucket] of byBase) {
    [...bucket].sort(collisionOrder).forEach((descriptor, index) => {
      const diagnostics: DeclaredToolDiagnostic[] = [];
      const { truncated } = sanitizeDeclaredToolName(descriptor.rawName, {
        prefix,
      });
      if (truncated) {
        diagnostics.push({
          code: "name_truncated",
          message:
            `"${descriptor.rawName}" does not fit the model-facing tool-name ` +
            `charset, so it is advertised under a shortened, hashed name.`,
        });
      }
      let name = base;
      if (index > 0) {
        // `_f<k>`: k STARTS at the index among same-named registrants, so the
        // second copy of a tool in a duplicated iframe is `_f1` whether or not
        // a main frame is in the running — and then walks forward past any
        // candidate another declaration already holds.
        const suffixed = (k: number) => {
          const suffix = `_f${k}`;
          return `${base.slice(0, DECLARED_TOOL_NAME_MAX_CHARS - suffix.length)}${suffix}`;
        };
        name = suffixed(index);
        // Bounded by the number of names in play: at most that many can be
        // taken, so a free one is always within reach.
        for (
          let k = index + 1;
          taken.has(name) && k <= index + total + 1;
          k += 1
        ) {
          name = suffixed(k);
        }
        if (taken.has(name)) {
          // Unreachable by the bound above, and still not a place to mint a
          // duplicate: hash the identity instead of trusting the count.
          const suffix = `_f${declaredToolHex8(
            `${descriptor.rawName}${SEP}${descriptor.frameId ?? ""}${SEP}${descriptor.registrationSeq ?? ""}`,
          )}`;
          name = `${base.slice(0, DECLARED_TOOL_NAME_MAX_CHARS - suffix.length)}${suffix}`;
        }
        taken.add(name);
        diagnostics.push({
          code: "name_suffixed",
          message:
            `another frame on this page declares a tool called ` +
            `"${descriptor.rawName}"; this one is advertised as ${name}.`,
        });
      }
      minted.push({
        name,
        rawName: descriptor.rawName,
        ...(descriptor.origin !== undefined
          ? { origin: descriptor.origin }
          : {}),
        ...(descriptor.frameId !== undefined
          ? { frameId: descriptor.frameId }
          : {}),
        isMainFrame: descriptor.isMainFrame === true,
        ...(descriptor.registrationSeq !== undefined
          ? { registrationSeq: descriptor.registrationSeq }
          : {}),
        registrationKind: descriptor.registrationKind ?? "unknown",
        description: describeDeclaredTool(descriptor),
        ...(descriptor.inputSchema !== undefined
          ? { inputSchema: descriptor.inputSchema }
          : {}),
        schemaHash: declaredSchemaHash(descriptor.inputSchema),
        ...(descriptor.annotations !== undefined
          ? { annotations: descriptor.annotations }
          : {}),
        diagnostics: [
          ...diagnostics,
          ...boundDeclaredSchema(descriptor.inputSchema),
        ],
      });
    });
  }
  // Sorted so two reads of one page produce an identically-ORDERED set, not
  // merely an identical one: the tool list is serialized into the request, and a
  // reordering is a cache miss on every provider that keys on the prompt.
  return minted.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

/** Is this a name this module minted for an agent-browser page tool? */
export function isWebmcpPageToolName(name: string): boolean {
  return (
    name.startsWith(WEBMCP_TOOL_NAME_PREFIX) &&
    name.length > WEBMCP_TOOL_NAME_PREFIX.length &&
    DECLARED_TOOL_NAME_REGEX.test(name)
  );
}

// ---------------------------------------------------------------------------
// Descriptions
// ---------------------------------------------------------------------------

/**
 * The origin, reduced to scheme + host, or "unknown".
 *
 * The provenance header is the one part of a tool description the model is meant
 * to trust, so nothing the page can write may reach it. Path, query and fragment
 * are all page-authored and are perfectly good places to address a sentence to a
 * model; `new URL(...).origin` keeps only the part that is not. Mirrors
 * `safeOrigin` in `built-in-tools/browser.ts`, which guards the result fence's
 * header for exactly the same reason.
 */
export function safeDeclaredOrigin(origin: string | undefined): string {
  if (!origin) return "unknown";
  const charset = /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9.:[\]-]+$/;
  try {
    const parsed = new URL(origin).origin;
    return charset.test(parsed) ? parsed : "unknown";
  } catch {
    return "unknown";
  }
}

/** Strip everything a declarer could hide a second message inside. */
export function sanitizeDeclaredText(text: string, maxChars: number): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_AND_INVISIBLE, "")
    .replace(FENCE_MARKERS, "[redacted]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > maxChars
    ? `${cleaned.slice(0, maxChars - 1).trimEnd()}…`
    : cleaned;
}

/**
 * What the model reads about a declared tool.
 *
 * The header is not decoration. A page tool's description is written by the
 * page, and tool DEFINITIONS — unlike tool results — are not wrapped in the
 * page-content fence. So the header is the model's only in-band cue that these
 * words came from a third party, and it names the origin so "this tool says it
 * is safe" can be weighed against WHO is saying it.
 */
export function describeDeclaredTool(
  descriptor: Pick<
    DeclaredToolDescriptor,
    "description" | "origin" | "isMainFrame" | "frameId"
  >,
): string {
  const origin = safeDeclaredOrigin(descriptor.origin);
  const embedded = descriptor.isMainFrame === true ? "" : " (embedded frame)";
  const header = `[WebMCP page tool — ${origin}${embedded}]`;
  const body = sanitizeDeclaredText(
    descriptor.description ?? "",
    WEBMCP_TOOL_DESCRIPTION_MAX_CHARS,
  );
  return body ? `${header} ${body}` : `${header} The page gave no description.`;
}

/**
 * The daemon's WebMCP descriptor, as a declared-tool descriptor.
 *
 * Structural rather than an import: the shapes are the same but for `name` vs
 * `rawName`, and this module must stay free of daemon imports so the daemon can
 * bundle it. One converter, used by the daemon (to hash a tab's set), the
 * server (to mint from an observation) and the client (to mint the same names
 * for the pane) — three re-derivations of this mapping is three ways for the
 * pane to name a tool the model never had.
 */
export function declaredToolsFromWebmcp(
  tools: ReadonlyArray<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    origin?: string;
    frameId?: string;
    isMainFrame?: boolean;
    registrationSeq?: number;
    registrationKind?: DeclaredToolRegistrationKind;
    annotations?: DeclaredToolAnnotations;
  }>,
): DeclaredToolDescriptor[] {
  return tools.map((tool) => ({
    rawName: tool.name,
    description: tool.description ?? "",
    ...(tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
    ...(tool.origin !== undefined ? { origin: tool.origin } : {}),
    ...(tool.frameId !== undefined ? { frameId: tool.frameId } : {}),
    isMainFrame: tool.isMainFrame === true,
    ...(tool.registrationSeq !== undefined
      ? { registrationSeq: tool.registrationSeq }
      : {}),
    registrationKind: tool.registrationKind ?? "unknown",
    ...(tool.annotations !== undefined
      ? { annotations: tool.annotations }
      : {}),
  }));
}

/**
 * The persistable record of what a turn advertised.
 *
 * Kept small on purpose: it rides inside every turn trace, and a schema copied
 * verbatim would put a page's whole `anyOf` of two hundred options into every
 * persisted turn. The schema HASH is enough to answer the question this record
 * exists for — "is the tool in this old card the same tool as the one on the
 * page now?" — and the exact definitions the Raw view replays come from the
 * turn's own request payload.
 */
export function toMintedPageToolRecords(
  minted: readonly MintedDeclaredTool[],
  binding?: { bootId: string; tabId: string; navCounter: number },
): MintedPageToolRecord[] {
  return minted.map((tool) => ({
    name: tool.name,
    rawName: tool.rawName,
    ...(tool.origin !== undefined ? { origin: tool.origin } : {}),
    schemaHash: tool.schemaHash,
    ...(binding &&
    tool.frameId !== undefined &&
    tool.registrationSeq !== undefined
      ? {
          binding: {
            bootId: binding.bootId,
            tabId: binding.tabId,
            navCounter: binding.navCounter,
            frameId: tool.frameId,
            registrationSeq: tool.registrationSeq,
          },
        }
      : {}),
  }));
}

/**
 * Persisted turn records, as rows the Raw view can list.
 *
 * NO `inputSchema`, and that omission is deliberate rather than a gap. The turn
 * record stores a schema DIGEST, not the schema — a page's `anyOf` of two
 * hundred `<option>` branches copied into every persisted turn would dwarf the
 * trace it annotates. So the honest thing to render for a reopened session is
 * the tool's identity and where it came from, with the digest, and NOT a schema
 * re-read from a browser that has long since navigated elsewhere. A schema
 * synthesized from the live page would be a confident answer to a question
 * about the past.
 */
export function pageToolRowsFromRecords(
  records: readonly MintedPageToolRecord[],
): SerializedModelRequestTool[] {
  return records.map((record) => ({
    name: record.name,
    description:
      `[WebMCP page tool — ${safeDeclaredOrigin(record.origin)}] ` +
      // THE PAGE'S OWN NAME, sanitized like every other page-authored string
      // that lands in a description: it sits beside the one header the model
      // is meant to trust, and a name is a fine place to write a sentence.
      `${sanitizeDeclaredText(record.rawName, 128) || "(unnamed)"}. ` +
      `Advertised on this turn; its schema is not replayed here ` +
      `(digest ${record.schemaHash}).`,
  }));
}

/** Model-request rows for a minted set, for the Tools pane and the Raw view. */
export function toSerializedModelRequestTools(
  minted: readonly MintedDeclaredTool[],
): SerializedModelRequestTool[] {
  return minted.map((tool) => ({
    name: tool.name,
    description: tool.description,
    ...(tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Keywords this validator EVALUATES. Everything else is passed through with a
 * diagnostic rather than rejected.
 *
 * The list is what Chrome's own WebMCP surface actually produces plus the
 * ordinary JSON Schema around it: the imperative example is a five-branch
 * `oneOf` of `const` + `title`, and the DECLARATIVE form generates an `anyOf`
 * of `const` + `title` from a `<select>`'s option text. An earlier revision of
 * this work capped `oneOf` at four branches and dropped `title` — which would
 * have rejected the example in the specification we are implementing.
 */
const EVALUATED_KEYWORDS = new Set([
  "type",
  "const",
  "enum",
  "required",
  "properties",
  "additionalProperties",
  "items",
  "prefixItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  // NOT `pattern`. A regular expression is page-authored code, and this
  // validator runs on the SERVER against a value the same page can steer the
  // model into sending: `^(a+)+$` with a 30-character input is seconds of
  // synchronous backtracking on a hosted replica, for every user on it. So the
  // keyword is reported as unsupported and the value passes, which is the
  // lenient rule this validator already follows for everything it cannot
  // check safely. The page's own handler still sees its declared contract.
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "$ref",
]);

/**
 * Keywords that carry no constraint, so their presence says nothing about
 * whether we can check an argument. `title` is in here because the declarative
 * WebMCP form puts an option's human label there — a schema full of them is
 * normal, not exotic.
 */
const ANNOTATION_KEYWORDS = new Set([
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "$schema",
  "$id",
  "$anchor",
  "$comment",
  "$defs",
  "definitions",
  "format",
  "contentMediaType",
  "contentEncoding",
]);

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Bounds a schema WITHOUT rewriting it (P1).
 *
 * Size and depth only, and both are reported as diagnostics rather than acted
 * on here: this function's whole contract is that the schema it looked at is
 * the schema the model gets. A too-large one is `blocking` — advertising it
 * would spend the turn's context — but it is still the page's own schema that
 * was refused, not a trimmed version of it silently offered in its place.
 */
export function boundDeclaredSchema(
  schema: Record<string, unknown> | undefined,
): DeclaredToolDiagnostic[] {
  if (schema === undefined) return [];
  const diagnostics: DeclaredToolDiagnostic[] = [];
  let serialized: string;
  try {
    serialized = canonicalJson(schema);
  } catch {
    return [
      {
        code: "schema_unsupported_keyword",
        message:
          "the page's input schema could not be serialized (it is cyclic or " +
          "contains values JSON cannot represent), so this tool is not offered.",
        blocking: true,
      },
    ];
  }
  const bytes = utf8Length(serialized);
  if (bytes > WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES) {
    diagnostics.push({
      code: "schema_too_large",
      message:
        `the page's input schema is ${bytes} bytes, over the ` +
        `${WEBMCP_TOOL_INPUT_SCHEMA_MAX_BYTES}-byte limit, so this tool is not offered.`,
      blocking: true,
    });
  }
  if (schemaDepth(schema) > WEBMCP_TOOL_INPUT_SCHEMA_MAX_DEPTH) {
    diagnostics.push({
      code: "schema_too_deep",
      message:
        `the page's input schema nests deeper than ` +
        `${WEBMCP_TOOL_INPUT_SCHEMA_MAX_DEPTH} levels, so this tool is not offered.`,
      blocking: true,
    });
  }
  return diagnostics;
}

/** Byte length of a UTF-8 encoding, without allocating a Buffer. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index)!;
    if (code > 0xffff) index += 1;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function schemaDepth(value: unknown, depth = 1): number {
  if (!isSchemaObject(value) && !Array.isArray(value)) return depth;
  if (depth > WEBMCP_TOOL_INPUT_SCHEMA_MAX_DEPTH + 1) return depth;
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  let deepest = depth;
  for (const child of children) {
    const found = schemaDepth(child, depth + 1);
    if (found > deepest) deepest = found;
  }
  return deepest;
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

export interface DeclaredArgsValidation {
  ok: boolean;
  /** Human-readable, path-prefixed reasons the arguments do not fit. */
  errors: string[];
  /** Constructs this validator could not evaluate. Never a rejection. */
  unsupported: string[];
}

/**
 * Check a model's arguments against the page's ORIGINAL schema, before any
 * command leaves this process.
 *
 * NOBODY ELSE DOES THIS. The hosted chat path has no SDK-side validation, and
 * Chrome does not validate an invocation against the registered `inputSchema`
 * either (WebMCP spec issue #92) — the page's `execute` is simply handed
 * whatever arrived. So an argument the model guessed wrong reaches page code as
 * a surprise value, and the observed failure was a model inventing an enum
 * member, being told nothing useful, and falling back to clicking.
 *
 * LENIENT BY CONSTRUCTION. A construct this validator cannot evaluate is
 * reported and PASSED, never refused: the schema is the page's contract, this
 * is a courtesy check in front of it, and a validator that refused what it did
 * not understand would make an unusual-but-valid schema an unusable tool. The
 * only rejections are things it positively determined to be wrong.
 */
export function validateDeclaredArgs(
  schema: Record<string, unknown> | undefined,
  input: unknown,
): DeclaredArgsValidation {
  if (schema === undefined) return { ok: true, errors: [], unsupported: [] };
  const state: ValidationState = {
    errors: [],
    unsupported: new Set<string>(),
    root: schema,
    budget: 5_000,
  };
  checkSchema(schema, input, "", state, 0);
  return {
    ok: state.errors.length === 0,
    errors: state.errors.slice(0, 12),
    unsupported: [...state.unsupported],
  };
}

interface ValidationState {
  errors: string[];
  unsupported: Set<string>;
  root: Record<string, unknown>;
  /** Node budget, so a pathological schema cannot spin a request thread. */
  budget: number;
}

/**
 * Ceiling on any schema-authored value quoted into a validation message.
 *
 * These messages are read by the model, and they sit in OUR half of a tool
 * result rather than inside the page-content fence — so every literal a page
 * can put in its schema (an enum member, a `const`, a property name, a `$ref`)
 * is a place it can write a sentence addressed to the model, at whatever
 * length it likes. Sanitized and capped here, at the one place they are
 * quoted, so no message can carry more than a short quoted value.
 */
const QUOTED_LITERAL_MAX_CHARS = 96;

/** A schema-authored value, quoted for a message: JSON-encoded, then bounded. */
function literal(value: unknown): string {
  const encoded = JSON.stringify(value) ?? String(value);
  return sanitizeDeclaredText(encoded, QUOTED_LITERAL_MAX_CHARS);
}

/** A schema-authored NAME (a property, a path segment), bounded the same way. */
function quotedName(name: string): string {
  return sanitizeDeclaredText(name, QUOTED_LITERAL_MAX_CHARS);
}

function at(path: string): string {
  return path ? `\`${quotedName(path)}\`` : "the input";
}

/**
 * Resolve a LOCAL `$ref` (`#/$defs/x`, `#/definitions/x`, `#`).
 *
 * Local only. A remote `$ref` would be a network fetch decided by a page, on a
 * server, during a tool call — so it is reported as unsupported and its subtree
 * passes unchecked, which is the lenient rule doing its job.
 */
function resolveRef(
  ref: string,
  root: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!ref.startsWith("#")) return undefined;
  const pointer = ref.slice(1);
  if (pointer === "" || pointer === "/") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of pointer.slice(1).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isSchemaObject(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return isSchemaObject(current) ? current : undefined;
}

/** Does `value` satisfy `schema`? Errors and diagnostics accumulate in `state`. */
function checkSchema(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number,
): void {
  if (depth > WEBMCP_TOOL_INPUT_SCHEMA_MAX_DEPTH || state.budget-- <= 0) {
    state.unsupported.add("deeply nested schema");
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!EVALUATED_KEYWORDS.has(keyword) && !ANNOTATION_KEYWORDS.has(keyword)) {
      state.unsupported.add(keyword);
    }
  }

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, state.root);
    if (resolved) checkSchema(resolved, value, path, state, depth + 1);
    else state.unsupported.add(`$ref ${literal(schema.$ref)}`);
    // A `$ref` alongside sibling keywords is 2020-12 behaviour; keep checking
    // them rather than returning, so `{$ref, minimum}` is fully evaluated.
  }

  checkType(schema, value, path, state);
  checkConstAndEnum(schema, value, path, state);
  if (typeof value === "string") checkString(schema, value, path, state);
  if (typeof value === "number") checkNumber(schema, value, path, state);
  if (Array.isArray(value)) checkArray(schema, value, path, state, depth);
  if (isSchemaObject(value)) checkObject(schema, value, path, state, depth);
  checkCombinators(schema, value, path, state, depth);
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isSchemaObject(value);
    default:
      return true;
  }
}

function checkType(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  state: ValidationState,
): void {
  const type = schema.type;
  const types =
    typeof type === "string"
      ? [type]
      : Array.isArray(type)
        ? type.filter((entry): entry is string => typeof entry === "string")
        : null;
  if (!types || types.length === 0) return;
  if (types.some((entry) => typeMatches(entry, value))) return;
  state.errors.push(
    `${at(path)} must be ${types.map(quotedName).join(" or ")}, but got ${describeValue(value)}.`,
  );
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** Deep equality over JSON values, for `const` and `enum`. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== "object") return false;
  return canonicalJson(a) === canonicalJson(b);
}

function checkConstAndEnum(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  state: ValidationState,
): void {
  if ("const" in schema && !jsonEqual(schema.const, value)) {
    state.errors.push(
      `${at(path)} must be ${literal(schema.const)}, but got ${describeValue(value)}.`,
    );
  }
  const options = schema.enum;
  if (
    Array.isArray(options) &&
    !options.some((option) => jsonEqual(option, value))
  ) {
    // The allowed values are LISTED. A model that guessed an enum member wrong
    // and is told only "invalid" guesses again; told the members, it fixes the
    // call on the next step.
    state.errors.push(
      `${at(path)} must be one of ${options
        .slice(0, 24)
        .map((option) => literal(option))
        .join(
          ", ",
        )}${options.length > 24 ? ", …" : ""}, but got ${describeValue(value)}.`,
    );
  }
}

function checkString(
  schema: Record<string, unknown>,
  value: string,
  path: string,
  state: ValidationState,
): void {
  if (typeof schema.minLength === "number" && value.length < schema.minLength) {
    state.errors.push(
      `${at(path)} must be at least ${schema.minLength} characters.`,
    );
  }
  if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    state.errors.push(
      `${at(path)} must be at most ${schema.maxLength} characters.`,
    );
  }
  // `pattern` is deliberately NOT evaluated — see `EVALUATED_KEYWORDS`. Compiling
  // and running a page's regular expression here is running page code on the
  // server against page-steered input, and one catastrophic pattern would
  // stall the event loop for everyone. The keyword loop above has already
  // reported it as unsupported.
}

function checkNumber(
  schema: Record<string, unknown>,
  value: number,
  path: string,
  state: ValidationState,
): void {
  if (typeof schema.minimum === "number" && value < schema.minimum) {
    state.errors.push(`${at(path)} must be at least ${schema.minimum}.`);
  }
  if (typeof schema.maximum === "number" && value > schema.maximum) {
    state.errors.push(`${at(path)} must be at most ${schema.maximum}.`);
  }
  if (
    typeof schema.exclusiveMinimum === "number" &&
    value <= schema.exclusiveMinimum
  ) {
    state.errors.push(
      `${at(path)} must be greater than ${schema.exclusiveMinimum}.`,
    );
  }
  if (
    typeof schema.exclusiveMaximum === "number" &&
    value >= schema.exclusiveMaximum
  ) {
    state.errors.push(
      `${at(path)} must be less than ${schema.exclusiveMaximum}.`,
    );
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9) {
      state.errors.push(
        `${at(path)} must be a multiple of ${schema.multipleOf}.`,
      );
    }
  }
}

function checkArray(
  schema: Record<string, unknown>,
  value: unknown[],
  path: string,
  state: ValidationState,
  depth: number,
): void {
  if (typeof schema.minItems === "number" && value.length < schema.minItems) {
    state.errors.push(
      `${at(path)} must have at least ${schema.minItems} items.`,
    );
  }
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
    state.errors.push(
      `${at(path)} must have at most ${schema.maxItems} items.`,
    );
  }
  if (schema.uniqueItems === true) {
    const seen = new Set(value.map((item) => canonicalJson(item)));
    if (seen.size !== value.length) {
      state.errors.push(`${at(path)} must not contain duplicate items.`);
    }
  }
  const prefixItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : null;
  if (prefixItems) {
    prefixItems.forEach((entry, index) => {
      if (isSchemaObject(entry) && index < value.length) {
        checkSchema(entry, value[index], `${path}[${index}]`, state, depth + 1);
      }
    });
  }
  const items = schema.items;
  if (isSchemaObject(items)) {
    const from = prefixItems ? prefixItems.length : 0;
    for (let index = from; index < value.length; index += 1) {
      checkSchema(items, value[index], `${path}[${index}]`, state, depth + 1);
    }
  } else if (Array.isArray(items)) {
    // Draft-07 tuple form, still what most generators emit.
    items.forEach((entry, index) => {
      if (isSchemaObject(entry) && index < value.length) {
        checkSchema(entry, value[index], `${path}[${index}]`, state, depth + 1);
      }
    });
  }
}

function checkObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  path: string,
  state: ValidationState,
  depth: number,
): void {
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    // `hasOwn`, not `in`: a required property called `constructor` or
    // `toString` is satisfied by every object under `in`, and an argument the
    // model forgot would pass as present.
    if (typeof key === "string" && !Object.hasOwn(value, key)) {
      state.errors.push(
        `${at(path)} is missing the required property \`${quotedName(key)}\`.`,
      );
    }
  }
  if (
    typeof schema.minProperties === "number" &&
    Object.keys(value).length < schema.minProperties
  ) {
    state.errors.push(
      `${at(path)} must have at least ${schema.minProperties} properties.`,
    );
  }
  if (
    typeof schema.maxProperties === "number" &&
    Object.keys(value).length > schema.maxProperties
  ) {
    state.errors.push(
      `${at(path)} must have at most ${schema.maxProperties} properties.`,
    );
  }
  const properties = isSchemaObject(schema.properties) ? schema.properties : {};
  for (const [key, child] of Object.entries(value)) {
    const childSchema = (properties as Record<string, unknown>)[key];
    if (isSchemaObject(childSchema)) {
      checkSchema(
        childSchema,
        child,
        path ? `${path}.${key}` : key,
        state,
        depth + 1,
      );
      continue;
    }
    const additional = schema.additionalProperties;
    if (additional === false) {
      state.errors.push(
        `${at(path)} does not allow the property \`${key}\`; allowed: ${
          Object.keys(properties).join(", ") || "(none)"
        }.`,
      );
    } else if (isSchemaObject(additional)) {
      checkSchema(
        additional,
        child,
        path ? `${path}.${key}` : key,
        state,
        depth + 1,
      );
    }
  }
}

/**
 * `oneOf` / `anyOf` / `allOf` / `not`.
 *
 * A branch this validator could not fully evaluate makes the WHOLE combinator
 * indeterminate, and an indeterminate combinator PASSES: rejecting on "none of
 * the branches matched" when one of them contained a construct we skipped would
 * refuse a perfectly valid argument. The diagnostic is how that shows up.
 */
function checkCombinators(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number,
): void {
  const branchOf = (entry: unknown) =>
    isSchemaObject(entry)
      ? branchResult(entry, value, path, state, depth)
      : null;

  for (const keyword of ["oneOf", "anyOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0) continue;
    const results = branches.map(branchOf);
    if (results.some((result) => result === null || result.indeterminate))
      continue;
    const matched = results.filter((result) => result!.ok).length;
    if (matched === 0) {
      // The branch errors themselves are the useful part: for Chrome's `oneOf`
      // of `const`s that is the list of allowed values, which is exactly what a
      // model needs to fix the call.
      const reasons = results
        .flatMap((result) => result!.errors)
        .slice(0, 6)
        .join(" ");
      state.errors.push(
        `${at(path)} does not match any allowed form. ${reasons}`.trim(),
      );
    } else if (keyword === "oneOf" && matched > 1) {
      state.errors.push(`${at(path)} matches more than one allowed form.`);
    }
  }

  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      if (isSchemaObject(branch)) {
        checkSchema(branch, value, path, state, depth + 1);
      }
    }
  }

  if (isSchemaObject(schema.not)) {
    const result = branchResult(schema.not, value, path, state, depth);
    if (!result.indeterminate && result.ok) {
      state.errors.push(`${at(path)} matches a disallowed form.`);
    }
  }
}

/** Evaluate a branch in isolation: its errors must not leak into the parent. */
function branchResult(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  parent: ValidationState,
  depth: number,
): { ok: boolean; errors: string[]; indeterminate: boolean } {
  const inner: ValidationState = {
    errors: [],
    unsupported: new Set<string>(),
    root: parent.root,
    budget: parent.budget,
  };
  checkSchema(schema, value, path, inner, depth + 1);
  parent.budget = inner.budget;
  for (const keyword of inner.unsupported) parent.unsupported.add(keyword);
  return {
    ok: inner.errors.length === 0,
    errors: inner.errors,
    indeterminate: inner.unsupported.size > 0,
  };
}

// ---------------------------------------------------------------------------
// Provider conversion
// ---------------------------------------------------------------------------

export type DeclaredToolProvider =
  "anthropic" | "openai" | "google" | "generic";

/**
 * Keywords a provider's tool-schema subset is known not to accept.
 *
 * Deliberately a report rather than a rewrite. Rewriting a page's schema to fit
 * a provider hands the model a contract the page never agreed to: drop a
 * `oneOf` and the model sends a shape the page's `execute` was never written
 * for, and the failure surfaces inside page code with nothing to trace it back
 * to. A diagnostic surfaces the same fact where a person can act on it.
 */
const PROVIDER_UNSUPPORTED: Record<
  DeclaredToolProvider,
  ReadonlySet<string>
> = {
  // Anthropic takes ordinary JSON Schema for `input_schema`.
  anthropic: new Set<string>(),
  openai: new Set([
    "if",
    "then",
    "else",
    "dependentSchemas",
    "unevaluatedProperties",
  ]),
  // Gemini's `FunctionDeclaration` takes an OpenAPI-flavoured subset.
  google: new Set([
    "oneOf",
    "not",
    "if",
    "then",
    "else",
    "$ref",
    "patternProperties",
    "dependentSchemas",
    "unevaluatedProperties",
    "additionalProperties",
  ]),
  generic: new Set<string>(),
};

export interface ProviderToolSchema {
  /** The page's schema, UNCHANGED. */
  schema: Record<string, unknown> | undefined;
  diagnostics: DeclaredToolDiagnostic[];
}

/**
 * State what a provider will and will not be able to express about this schema.
 *
 * An EXPLICIT step, called where the tool is built rather than hidden inside a
 * serializer, because "the model saw a different contract from the one the page
 * published" is a fact somebody has to be able to see. The schema comes back
 * byte-identical; only the diagnostics differ by provider.
 */
export function toProviderToolSchema(
  schema: Record<string, unknown> | undefined,
  provider: DeclaredToolProvider,
): ProviderToolSchema {
  if (schema === undefined) return { schema, diagnostics: [] };
  const diagnostics: DeclaredToolDiagnostic[] = [];
  // EVERY provider requires a tool's input to be an object. A page may register
  // `{"type":"string"}`, which is legal WebMCP and unusable as a tool schema —
  // blocking, because there is no honest way to advertise it.
  if (schema.type !== undefined && schema.type !== "object") {
    diagnostics.push({
      code: "schema_not_object",
      message:
        `this tool's input schema is \`${JSON.stringify(schema.type)}\` rather ` +
        `than an object, which no model provider can express as tool arguments.`,
      blocking: true,
    });
  }
  const unsupported = PROVIDER_UNSUPPORTED[provider];
  if (unsupported.size > 0) {
    const found = [...collectKeywords(schema)].filter((keyword) =>
      unsupported.has(keyword),
    );
    if (found.length > 0) {
      diagnostics.push({
        code: "provider_unsupported",
        message:
          `the page's input schema uses ${found.join(", ")}, which the ` +
          `${provider} tool-schema subset does not express; the schema is sent ` +
          `unchanged and the provider may reject or ignore those parts.`,
      });
    }
  }
  return { schema, diagnostics };
}

/** Every keyword appearing anywhere in a schema, bounded by depth. */
function collectKeywords(
  schema: unknown,
  depth = 0,
  found = new Set<string>(),
): Set<string> {
  if (depth > WEBMCP_TOOL_INPUT_SCHEMA_MAX_DEPTH) return found;
  if (Array.isArray(schema)) {
    for (const entry of schema) collectKeywords(entry, depth + 1, found);
    return found;
  }
  if (!isSchemaObject(schema)) return found;
  for (const [key, value] of Object.entries(schema)) {
    found.add(key);
    collectKeywords(value, depth + 1, found);
  }
  return found;
}
