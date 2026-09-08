/**
 * **Friction signals** — observable patterns in one trial's tool calls that
 * MAY mean the agent did avoidable work, and are NEVER a verdict about it.
 *
 * This module is browser-safe and intentionally has no node-only deps.
 *
 * Every signal here has a benign reading, and the benign reading is often the
 * right one:
 *
 *   - `identifierSurfacedUnused` — a result surfaced identifiers and no later
 *     call carried one. Benign: the search already answered the question, and
 *     the identifier was never needed.
 *   - `searchRepeatedAfterIdentifier` — the same tool was searched again after
 *     it had already returned identifiers. Benign: a sensible refinement, or a
 *     second, genuinely different question.
 *   - `identicalRetry` — a call repeated with byte-identical arguments.
 *     Benign: a recovery after a transient error, which is the behaviour we
 *     want.
 *   - `changedRetry` — the same tool called again with different arguments.
 *     Benign: ordinary exploration; most useful work looks like this.
 *   - `paginationContinuation` — the same tool called again with only the
 *     pagination keys changed. Benign by construction, and named here so it
 *     can never be counted as a repeat (see {@link PAGINATION_ARG_KEYS}).
 *
 * ── It REPORTS; it never DECIDES ─────────────────────────────────────────────
 *
 * Nothing here writes `result`, feeds a gate, enters a verdict, or touches the
 * user-value chain. Same discipline as `./route-facts.ts`: a document that
 * could not be measured says `notMeasured` with a reason, and a missing
 * document is UNMEASURED rather than zero.
 *
 * ── Availability is a CONTRACT, not an array position ────────────────────────
 *
 * An identifier signal may only claim "this result was available before that
 * call" when it can prove it. For the emulated engine, message order is
 * causal — the tool result precedes the next assistant turn — so index order
 * suffices. For a harness run the graded array is narration order with
 * wire-only calls APPENDED, so a call at a later index may have settled
 * earlier; there, availability needs `settledAtMs(k) < startedAtMs(j)` from
 * the evidence rows. A trial that cannot answer the question reports
 * `identifierSignals: { state: "notMeasured", reason: "orderingUnknown" }`
 * and keeps its adjacency signals, which never depended on timing.
 *
 * ── Privacy ──────────────────────────────────────────────────────────────────
 *
 * Identifier VALUES never leave this module. A signal carries the KEY PATHS an
 * identifier was found under (`results[].id`) and a count; nothing else.
 *
 * ── No `.default()`, every object `.strict()` ────────────────────────────────
 *
 * Same reason `./route-facts.ts` gives: an omitted field stays omitted so the
 * payload is byte-stable, and an unknown field is an error rather than a
 * silent passenger.
 */

import { z } from "zod";
import { CanonicalJsonError, canonicalJson } from "./canonical.js";

/**
 * Derivation semantics version. Bump when a RULE changes, even if the shape
 * does not — two rows produced under different rules are different facts
 * under the same field names.
 */
export const FRICTION_SIGNALS_VERSION = 1;
export type FrictionSignalsVersion = typeof FRICTION_SIGNALS_VERSION;

// ── closed vocabularies ──────────────────────────────────────────────────────

export const FRICTION_SIGNAL_KINDS = [
  "identifierSurfacedUnused",
  "searchRepeatedAfterIdentifier",
  "identicalRetry",
  "changedRetry",
  "paginationContinuation",
] as const;
export type FrictionSignalKind = (typeof FRICTION_SIGNAL_KINDS)[number];
export const frictionSignalKindSchema = z.enum(FRICTION_SIGNAL_KINDS);
export function isFrictionSignalKind(
  value: unknown
): value is FrictionSignalKind {
  return (
    typeof value === "string" &&
    (FRICTION_SIGNAL_KINDS as readonly string[]).includes(value)
  );
}

/** The two kinds that depend on a result having been available. */
const IDENTIFIER_SIGNAL_KINDS: readonly FrictionSignalKind[] = [
  "identifierSurfacedUnused",
  "searchRepeatedAfterIdentifier",
];

/**
 * Why a trial, or its identifier signals alone, could not be measured.
 *
 *   - `noToolCalls` — the trial made none.
 *   - `resultsUnavailable` — at least one call's result was not retained, so
 *     "no later call used this identifier" cannot be checked.
 *   - `orderingUnknown` — the calls cannot be placed in a causal order (see
 *     the availability contract above).
 *   - `evidenceIncomplete` — the evidence set is known to have a hole, or an
 *     argument value could not be canonicalized.
 *   - `truncated` — the trial made more than {@link MAX_FRICTION_CALLS} calls,
 *     so no call index in this document could be trusted to mean what it says.
 */
export const FRICTION_NOT_MEASURED_REASONS = [
  "noToolCalls",
  "resultsUnavailable",
  "orderingUnknown",
  "evidenceIncomplete",
  "truncated",
] as const;
export type FrictionNotMeasuredReason =
  (typeof FRICTION_NOT_MEASURED_REASONS)[number];
export const frictionNotMeasuredReasonSchema = z.enum(
  FRICTION_NOT_MEASURED_REASONS
);
export function isFrictionNotMeasuredReason(
  value: unknown
): value is FrictionNotMeasuredReason {
  return (
    typeof value === "string" &&
    (FRICTION_NOT_MEASURED_REASONS as readonly string[]).includes(value)
  );
}

// ── caps ─────────────────────────────────────────────────────────────────────

/** Signals retained per trial. One pathological loop cannot write forever. */
export const MAX_FRICTION_SIGNALS = 24;

/**
 * Calls a trial may make and still be measured.
 *
 * Past this the document is `notMeasured: "truncated"` rather than derived
 * over a prefix: every index in a signal points into the graded
 * `actualToolCalls` array, and a prefix would silently redefine what those
 * indexes address.
 */
export const MAX_FRICTION_CALLS = 200;

/** Distinct key paths named per identifier signal. */
export const MAX_IDENTIFIER_KEY_PATHS = 8;

/** Repeat call indexes named per `searchRepeatedAfterIdentifier`. */
export const MAX_REPEAT_CALL_INDEXES = 8;

/** Identifier candidates collected from one result. */
export const MAX_IDENTIFIER_CANDIDATES = 200;

/** Pagination keys named per `paginationContinuation`. */
export const MAX_PAGINATION_KEYS = 4;

/** Depth the identifier walk descends into a result payload. */
export const IDENTIFIER_WALK_DEPTH = 6;

/** Array entries the identifier walk visits per array. */
export const IDENTIFIER_WALK_ARRAY_ITEMS = 50;

/**
 * Shortest string (or stringified number) that may be an identifier.
 *
 * Two characters collide with far too much — a `"12"` appears inside half the
 * timestamps, counts and offsets an agent passes — and a candidate that
 * matches everything suppresses the very signal it is part of.
 */
export const MIN_IDENTIFIER_LENGTH = 3;

/**
 * Argument keys whose change is pagination, not a new question.
 *
 * A later same-tool call differing from the prior one ONLY in these keys is a
 * `paginationContinuation` and is never a `searchRepeatedAfterIdentifier` —
 * "it asked again" would be a false reading of a tool doing exactly what its
 * cursor is for. Top-level only: these are call parameters, and a `limit`
 * buried inside a filter object is part of the question being asked.
 */
export const PAGINATION_ARG_KEYS = [
  "cursor",
  "nextCursor",
  "page",
  "pageToken",
  "offset",
  "after",
  "before",
  "start",
  "limit",
] as const;
export type PaginationArgKey = (typeof PAGINATION_ARG_KEYS)[number];
const PAGINATION_ARG_KEY_SET: ReadonlySet<string> = new Set(
  PAGINATION_ARG_KEYS
);

/**
 * Keys whose VALUE is an identifier because of what the key is called.
 *
 * `(^|_)(id|ids|key|uuid|slug|number|ref|identifier)$` catches `id`,
 * `issue_id`, `external_key`; `Id$` catches `issueId`, `parentId`. Together
 * with {@link ID_LIKE_LITERAL_RE} these are the whole tunable surface of the
 * identifier rules — the labelling round in
 * `~/.claude/plans/friction-signals-validation.md` moves these two and
 * nothing else.
 */
const IDENTIFIER_KEY_RE = /(^|_)(id|ids|key|uuid|slug|number|ref|identifier)$/i;
const IDENTIFIER_CAMEL_KEY_RE = /Id$/;

/**
 * A string that LOOKS like an identifier wherever it appears.
 *
 * Ported from `mcpjam-backend/convex/lib/testCaseAuthoringLints.ts`'s
 * `ID_LIKE_LITERAL_RE` (prefixed keys and UUIDs), widened here with two shapes
 * that dominate real MCP payloads and which that lint never needed: ULIDs
 * (Crockford base32, 26 chars) and bare hex object ids.
 */
const ID_LIKE_LITERAL_RE =
  /^(?:[A-Za-z]{1,12}-[A-Za-z0-9]{1,32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8,})$/i;

/**
 * Whether a string is worth trying to `JSON.parse`.
 *
 * Ported verbatim from `mcpjam-backend/convex/lib/traceRepairPrompt.ts`'s
 * `looksLikeJsonDocumentString`: a tool that returns JSON as text is the
 * common case, and parsing every text part unconditionally would spend the
 * walk budget on prose.
 */
function looksLikeJsonDocumentString(value: string): boolean {
  const trimmed = value.trim();
  return (
    (trimmed.startsWith("{") && trimmed.includes("}")) ||
    (trimmed.startsWith("[") && trimmed.includes("]"))
  );
}

// ── inputs ───────────────────────────────────────────────────────────────────

/** How one call's position in time may be compared with another's. */
export const FRICTION_ORDERINGS = ["messageOrder", "timed", "unknown"] as const;
export type FrictionOrdering = (typeof FRICTION_ORDERINGS)[number];

/** One tool result, already normalized away from its several placements. */
export type FrictionCallResult = {
  structuredContent?: unknown;
  /** Text content parts, in order. Parsed as JSON only when they look it. */
  textParts: string[];
  isError: boolean;
};

/**
 * One call, as the deriver needs it: what was called, with what, what came
 * back, and whether this trial can say when.
 *
 * `index` is the position in the trial's GRADED `actualToolCalls` array — the
 * same array the run page renders and the judge slices — so a signal's indexes
 * address something a reader can look at. Results are joined by `toolCallId`,
 * never by position.
 */
export type FrictionCallRecord = {
  index: number;
  toolName: string;
  toolCallId?: string;
  arguments: unknown;
  result?: FrictionCallResult;
  /** Whether a result was retained for this call at all. */
  resultAvailable: boolean;
  startedAtMs?: number;
  settledAtMs?: number;
  ordering: FrictionOrdering;
};

/** One retained tool result, keyed by the call it answers. */
export type FrictionResultEntry = {
  /**
   * The raw payload as the engine stored it: a `tool-result` content item, or
   * the bare `CallToolResult` a wire-only call carries. Both are read.
   */
  raw: unknown;
  /**
   * Whether the call FAILED, when the producer knows it from something the
   * payload does not carry.
   *
   * A JSON-RPC failure's `raw` is the error envelope — `{code, message}` — and
   * has no `isError` anywhere in it, so `frictionResultIsError` reads it as a
   * successful result and the identifier walk would mine an error for
   * identifiers. The harness merge classifies every call
   * (`outcomeKind`) and is the only place that knows; it passes the answer
   * here rather than expecting this module to re-derive it from a shape that
   * does not state it.
   */
  isError?: boolean;
  /** Wire timing, when the producer had it. Both or neither. */
  startedAtMs?: number;
  settledAtMs?: number;
};

// ── output schemas ───────────────────────────────────────────────────────────

const callIndexSchema = z.number().int().min(0);
const countSchema = z.number().int().min(0);
const toolNameSchema = z.string().min(1);
const keyPathSchema = z.string().min(1);

const identifierSurfacedUnusedSchema = z
  .object({
    kind: z.literal("identifierSurfacedUnused"),
    /** Where the identifiers appeared. */
    informationCallIndex: callIndexSchema,
    /**
     * The call that made the pattern OBSERVABLE — the last later call that
     * could have used an identifier and did not. It is the judge's evidence
     * bound: nothing after it may be shown.
     */
    observedAtCallIndex: callIndexSchema,
    toolName: toolNameSchema,
    toolCallId: z.string().min(1).optional(),
    identifierKeyPaths: z.array(keyPathSchema).max(MAX_IDENTIFIER_KEY_PATHS),
    identifierCount: z.number().int().min(1),
    laterCallCount: z.number().int().min(2),
  })
  .strict();

const searchRepeatedAfterIdentifierSchema = z
  .object({
    kind: z.literal("searchRepeatedAfterIdentifier"),
    informationCallIndex: callIndexSchema,
    observedAtCallIndex: callIndexSchema,
    toolName: toolNameSchema,
    toolCallId: z.string().min(1).optional(),
    repeatCallIndexes: z
      .array(callIndexSchema)
      .min(1)
      .max(MAX_REPEAT_CALL_INDEXES),
    identifierKeyPaths: z.array(keyPathSchema).max(MAX_IDENTIFIER_KEY_PATHS),
    identifierCount: z.number().int().min(1),
  })
  .strict();

const identicalRetrySchema = z
  .object({
    kind: z.literal("identicalRetry"),
    callIndex: callIndexSchema,
    priorCallIndex: callIndexSchema,
    toolName: toolNameSchema,
    /** Whether the call this repeats returned an error. */
    afterError: z.boolean(),
  })
  .strict();

const changedRetrySchema = z
  .object({
    kind: z.literal("changedRetry"),
    callIndex: callIndexSchema,
    priorCallIndex: callIndexSchema,
    toolName: toolNameSchema,
    afterError: z.boolean(),
  })
  .strict();

const paginationContinuationSchema = z
  .object({
    kind: z.literal("paginationContinuation"),
    callIndex: callIndexSchema,
    priorCallIndex: callIndexSchema,
    toolName: toolNameSchema,
    paginationKeys: z
      .array(z.enum(PAGINATION_ARG_KEYS))
      .min(1)
      .max(MAX_PAGINATION_KEYS),
  })
  .strict();

export const frictionSignalSchema = z.discriminatedUnion("kind", [
  identifierSurfacedUnusedSchema,
  searchRepeatedAfterIdentifierSchema,
  identicalRetrySchema,
  changedRetrySchema,
  paginationContinuationSchema,
]);
export type FrictionSignal = z.infer<typeof frictionSignalSchema>;
export type IdentifierSurfacedUnusedSignal = z.infer<
  typeof identifierSurfacedUnusedSchema
>;
export type SearchRepeatedAfterIdentifierSignal = z.infer<
  typeof searchRepeatedAfterIdentifierSchema
>;
export type IdenticalRetrySignal = z.infer<typeof identicalRetrySchema>;
export type ChangedRetrySignal = z.infer<typeof changedRetrySchema>;
export type PaginationContinuationSignal = z.infer<
  typeof paginationContinuationSchema
>;

/**
 * Whether the identifier-dependent kinds were measured at all.
 *
 * A `{state}` union like `EvalRouteMismatchFacts`, and for the same reason: a
 * trial whose results were never retained has no identifier observations, and
 * an empty array would say it looked and found nothing.
 */
export const frictionIdentifierSignalsSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("measured") }).strict(),
  z
    .object({
      state: z.literal("notMeasured"),
      reason: frictionNotMeasuredReasonSchema,
    })
    .strict(),
]);
export type FrictionIdentifierSignals = z.infer<
  typeof frictionIdentifierSignalsSchema
>;

export const evalTrialFrictionSignalsStructuralSchema = z
  .object({
    version: z.literal(FRICTION_SIGNALS_VERSION),
    state: z.enum(["measured", "notMeasured"]),
    notMeasuredReason: frictionNotMeasuredReasonSchema.optional(),
    /** Calls in the graded array, counted BEFORE any cap was applied. */
    callCount: countSchema,
    resultAvailableCount: countSchema,
    timedCallCount: countSchema,
    identifierSignals: frictionIdentifierSignalsSchema,
    signals: z.array(frictionSignalSchema).max(MAX_FRICTION_SIGNALS),
  })
  .strict();

/** The observation index a signal is ordered by — where it became visible. */
export function frictionSignalObservationIndex(signal: FrictionSignal): number {
  return signal.kind === "identifierSurfacedUnused" ||
    signal.kind === "searchRepeatedAfterIdentifier"
    ? signal.observedAtCallIndex
    : signal.callIndex;
}

export const evalTrialFrictionSignalsSchema =
  evalTrialFrictionSignalsStructuralSchema.superRefine((row, ctx) => {
    if (row.state === "notMeasured") {
      if (row.notMeasuredReason === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["notMeasuredReason"],
          message: "a notMeasured document must say why",
        });
      }
      if (row.signals.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["signals"],
          message: "a notMeasured document cannot carry signals",
        });
      }
    } else if (row.notMeasuredReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["notMeasuredReason"],
        message: "a measured document must not carry a notMeasured reason",
      });
    }

    if (row.resultAvailableCount > row.callCount) {
      ctx.addIssue({
        code: "custom",
        path: ["resultAvailableCount"],
        message:
          `resultAvailableCount ${row.resultAvailableCount} cannot exceed ` +
          `callCount ${row.callCount}`,
      });
    }
    if (row.timedCallCount > row.callCount) {
      ctx.addIssue({
        code: "custom",
        path: ["timedCallCount"],
        message:
          `timedCallCount ${row.timedCallCount} cannot exceed callCount ` +
          `${row.callCount}`,
      });
    }

    let previousObservation = -1;
    for (const [index, signal] of row.signals.entries()) {
      const at: PropertyKey[] = ["signals", index];
      if (
        row.identifierSignals.state === "notMeasured" &&
        IDENTIFIER_SIGNAL_KINDS.includes(signal.kind)
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...at, "kind"],
          message:
            "identifier signals are notMeasured, so no identifier-kind " +
            "signal may be present",
        });
      }
      const indexes: [string, number][] =
        signal.kind === "identifierSurfacedUnused" ||
        signal.kind === "searchRepeatedAfterIdentifier"
          ? [
              ["informationCallIndex", signal.informationCallIndex],
              ["observedAtCallIndex", signal.observedAtCallIndex],
            ]
          : [
              ["priorCallIndex", signal.priorCallIndex],
              ["callIndex", signal.callIndex],
            ];
      for (const [field, value] of indexes) {
        if (value >= row.callCount) {
          ctx.addIssue({
            code: "custom",
            path: [...at, field],
            message: `${field} ${value} must be below callCount ${row.callCount}`,
          });
        }
      }
      if (
        signal.kind === "identifierSurfacedUnused" ||
        signal.kind === "searchRepeatedAfterIdentifier"
      ) {
        if (signal.informationCallIndex >= signal.observedAtCallIndex) {
          ctx.addIssue({
            code: "custom",
            path: [...at, "observedAtCallIndex"],
            message:
              "observedAtCallIndex must be after informationCallIndex — the " +
              "pattern cannot become observable before it happened",
          });
        }
        if (signal.kind === "searchRepeatedAfterIdentifier") {
          for (const [position, repeat] of signal.repeatCallIndexes.entries()) {
            if (repeat > signal.observedAtCallIndex) {
              ctx.addIssue({
                code: "custom",
                path: [...at, "repeatCallIndexes", position],
                message: "a repeat cannot fall after the observation index",
              });
            }
          }
        }
      } else if (signal.priorCallIndex >= signal.callIndex) {
        ctx.addIssue({
          code: "custom",
          path: [...at, "priorCallIndex"],
          message: "priorCallIndex must be before callIndex",
        });
      }

      const observation = frictionSignalObservationIndex(signal);
      if (observation < previousObservation) {
        ctx.addIssue({
          code: "custom",
          path: at,
          message:
            "signals must be ordered by the call that made them observable",
        });
      }
      previousObservation = observation;
    }
  });
export type EvalTrialFrictionSignals = z.infer<
  typeof evalTrialFrictionSignalsSchema
>;

// ── result normalization ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read the MCP `isError` flag from the three placements it has lived in.
 *
 * Ported from `mcpjam-backend/convex/lib/toolResultShape.ts`'s
 * `toolResultIsError`: directly on the tool-result item, under `result`, and
 * under `output.value`. A consumer that checks only one reads a failed call as
 * a successful one.
 */
export function frictionResultIsError(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (raw.isError === true) return true;
  const onResult = isRecord(raw.result) ? raw.result.isError : undefined;
  if (onResult === true) return true;
  const outputValue = isRecord(raw.output) ? raw.output.value : undefined;
  return isRecord(outputValue) && outputValue.isError === true;
}

/**
 * The payload half of a tool-result item: `result` when the item carries the
 * raw `CallToolResult`, `output.value` when it carries only the model-visible
 * projection, and the value itself when it IS the raw result.
 */
function resultPayload(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  if (raw.result !== undefined) return raw.result;
  const outputValue = isRecord(raw.output) ? raw.output.value : undefined;
  if (outputValue !== undefined) return outputValue;
  return raw;
}

function readTextParts(payload: unknown): string[] {
  const parts: string[] = [];
  if (typeof payload === "string") {
    parts.push(payload);
    return parts;
  }
  if (!isRecord(payload)) return parts;
  const content = payload.content;
  if (!Array.isArray(content)) return parts;
  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type !== undefined && item.type !== "text") continue;
    if (typeof item.text === "string") parts.push(item.text);
  }
  return parts;
}

/** Normalize one stored result into the shape the deriver reads. */
export function normalizeFrictionResult(raw: unknown): FrictionCallResult {
  const payload = resultPayload(raw);
  const structuredContent = isRecord(payload)
    ? payload.structuredContent
    : undefined;
  return {
    ...(structuredContent !== undefined ? { structuredContent } : {}),
    textParts: readTextParts(payload),
    isError: frictionResultIsError(raw),
  };
}

// ── identifier extraction ────────────────────────────────────────────────────

type IdentifierCandidate = { value: string; keyPath: string };

function candidateFromScalar(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length >= MIN_IDENTIFIER_LENGTH ? trimmed : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = String(value);
    return text.length >= MIN_IDENTIFIER_LENGTH ? text : undefined;
  }
  return undefined;
}

function keyNamesAnIdentifier(key: string): boolean {
  return IDENTIFIER_KEY_RE.test(key) || IDENTIFIER_CAMEL_KEY_RE.test(key);
}

function joinKeyPath(parent: string, key: string): string {
  return parent.length === 0 ? key : `${parent}.${key}`;
}

/**
 * Collect identifier candidates from one payload, with their key paths.
 *
 * Two rules, deliberately independent: a value is a candidate because of the
 * KEY it sits under, or because the value itself is id-SHAPED. Array indexes
 * collapse to `[]` in the path so `results[0].id` and `results[7].id` are the
 * same fact about the payload rather than two.
 */
function collectIdentifierCandidates(
  value: unknown,
  keyPath: string,
  depth: number,
  keyNamed: boolean,
  out: IdentifierCandidate[],
  walk: { truncated: boolean }
): void {
  if (out.length >= MAX_IDENTIFIER_CANDIDATES) {
    walk.truncated = true;
    return;
  }
  if (Array.isArray(value)) {
    if (depth >= IDENTIFIER_WALK_DEPTH) {
      if (value.length > 0) walk.truncated = true;
      return;
    }
    const limit = Math.min(value.length, IDENTIFIER_WALK_ARRAY_ITEMS);
    if (limit < value.length) walk.truncated = true;
    for (let index = 0; index < limit; index += 1) {
      collectIdentifierCandidates(
        value[index],
        `${keyPath}[]`,
        depth + 1,
        keyNamed,
        out,
        walk
      );
    }
    return;
  }
  if (isRecord(value)) {
    if (depth >= IDENTIFIER_WALK_DEPTH) {
      if (Object.keys(value).length > 0) walk.truncated = true;
      return;
    }
    for (const key of Object.keys(value).sort()) {
      collectIdentifierCandidates(
        value[key],
        joinKeyPath(keyPath, key),
        depth + 1,
        keyNamesAnIdentifier(key),
        out,
        walk
      );
    }
    return;
  }
  const candidate = candidateFromScalar(value);
  if (candidate === undefined) return;
  if (!keyNamed && !ID_LIKE_LITERAL_RE.test(candidate)) return;
  out.push({ value: candidate, keyPath: keyPath.length > 0 ? keyPath : "$" });
}

/**
 * Every identifier a result surfaced, deduped by value, with the key paths
 * they were found under.
 *
 * `structuredContent` when the server sent one, otherwise the text parts that
 * look like JSON documents. A text part that is not JSON is left alone: prose
 * containing something id-shaped is not the server surfacing an identifier.
 */
export function extractResultIdentifiers(result: FrictionCallResult): {
  values: string[];
  keyPaths: string[];
  /**
   * Whether the walk stopped short of the whole payload — a candidate cap, a
   * depth limit, or an array longer than the per-array budget.
   *
   * LOAD-BEARING, not diagnostic. The identifier rules fire on the ABSENCE of
   * a candidate in a later call's arguments, so a candidate set that is
   * incomplete produces false signals: an identifier the walk never reached,
   * used by a later call, reads as "nothing was used". A truncated walk
   * therefore withholds this call's identifier signals rather than reporting
   * what it happened to see.
   */
  truncated: boolean;
} {
  const candidates: IdentifierCandidate[] = [];
  const walk = { truncated: false };
  if (result.structuredContent !== undefined) {
    collectIdentifierCandidates(
      result.structuredContent,
      "",
      0,
      false,
      candidates,
      walk
    );
  } else {
    for (const part of result.textParts) {
      if (candidates.length >= MAX_IDENTIFIER_CANDIDATES) {
        walk.truncated = true;
        break;
      }
      if (!looksLikeJsonDocumentString(part)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(part);
      } catch {
        continue;
      }
      collectIdentifierCandidates(parsed, "", 0, false, candidates, walk);
    }
  }

  const values = new Set<string>();
  const keyPaths = new Set<string>();
  for (const candidate of candidates) {
    values.add(candidate.value);
    keyPaths.add(candidate.keyPath);
  }
  return {
    values: [...values].sort(),
    keyPaths: [...keyPaths].sort(),
    truncated: walk.truncated,
  };
}

/**
 * Whether a canonical-JSON argument string carries `candidate` as a whole
 * token.
 *
 * Word characters bound a token, so `123` is NOT found inside `1234` (the
 * following `4` continues the token) while it IS found inside `"item-123"`
 * (`-` ends it). Erring toward "this counts as a use" is deliberate: a missed
 * use fires a signal that is not there, and precision is what the validation
 * gate measures.
 */
function argumentsCarryToken(canonicalArguments: string, candidate: string) {
  const isWordChar = (character: string | undefined): boolean =>
    character !== undefined && /[A-Za-z0-9_]/.test(character);
  let from = 0;
  for (;;) {
    const at = canonicalArguments.indexOf(candidate, from);
    if (at < 0) return false;
    const before = at > 0 ? canonicalArguments[at - 1] : undefined;
    const after = canonicalArguments[at + candidate.length];
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

// ── argument comparison ──────────────────────────────────────────────────────

function withoutPaginationKeys(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (PAGINATION_ARG_KEY_SET.has(key)) continue;
    out[key] = value[key];
  }
  return out;
}

/** The pagination keys whose values differ between two argument objects. */
function changedPaginationKeys(a: unknown, b: unknown): PaginationArgKey[] {
  const left = isRecord(a) ? a : {};
  const right = isRecord(b) ? b : {};
  const changed: PaginationArgKey[] = [];
  for (const key of PAGINATION_ARG_KEYS) {
    const inLeft = Object.prototype.hasOwnProperty.call(left, key);
    const inRight = Object.prototype.hasOwnProperty.call(right, key);
    if (!inLeft && !inRight) continue;
    let same = false;
    try {
      same =
        inLeft &&
        inRight &&
        canonicalJson(left[key]) === canonicalJson(right[key]);
    } catch {
      same = false;
    }
    if (!same) changed.push(key);
  }
  return changed;
}

// ── availability ─────────────────────────────────────────────────────────────

/**
 * Whether call `k`'s result was demonstrably available before call `j` started.
 *
 * Message order is causal for the emulated engine; wire timing is the only
 * proof for a harness run, whose graded array appends wire-only calls after
 * the narrated ones. Anything else is `false` — and the caller has already
 * refused to derive identifier signals for such a trial, so `false` here is
 * belt-and-braces, not the mechanism.
 */
export function availableBefore(
  k: FrictionCallRecord,
  j: FrictionCallRecord
): boolean {
  if (k.ordering === "messageOrder" && j.ordering === "messageOrder") {
    return k.index < j.index;
  }
  if (k.ordering === "timed" && j.ordering === "timed") {
    return (
      typeof k.settledAtMs === "number" &&
      typeof j.startedAtMs === "number" &&
      k.settledAtMs < j.startedAtMs
    );
  }
  return false;
}

// ── builders ─────────────────────────────────────────────────────────────────

/**
 * Read a `toolCallId -> result` map out of a trace transcript.
 *
 * Only `tool-result` items that carry `result` — the RAW `CallToolResult` —
 * are taken. An item with a model-visible `output` and no `result` says what
 * the model saw and not what the server returned, and the identifier rules ask
 * the second question. Entries carry no timing, so their calls are
 * `messageOrder`.
 */
export function buildResultsByToolCallIdFromMessages(
  messages: readonly unknown[]
): Map<string, FrictionResultEntry> {
  const out = new Map<string, FrictionResultEntry>();
  for (const message of messages) {
    if (!isRecord(message) || message.role !== "tool") continue;
    const content = message.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type !== "tool-result") continue;
      if (typeof item.toolCallId !== "string" || item.toolCallId.length === 0) {
        continue;
      }
      if (!("result" in item)) continue;
      out.set(item.toolCallId, { raw: item });
    }
  }
  return out;
}

/**
 * The one record builder both engines use.
 *
 * `toolsCalled` is the trial's GRADED `actualToolCalls` array — narration
 * order for emulated runs, and for harness runs narration order with
 * narration-only calls dropped and wire-only calls appended under
 * `evidence:<requestId>`. Results are joined by `toolCallId` and never by
 * position, which is the whole reason the appended calls are safe to carry.
 */
export function buildFrictionCallRecords(args: {
  toolsCalled: readonly unknown[];
  resultsByToolCallId?: ReadonlyMap<string, FrictionResultEntry>;
}): FrictionCallRecord[] {
  const results = args.resultsByToolCallId;
  const records: FrictionCallRecord[] = [];
  for (const [index, call] of args.toolsCalled.entries()) {
    const record = isRecord(call) ? call : {};
    const toolName =
      typeof record.toolName === "string" && record.toolName.length > 0
        ? record.toolName
        : typeof record.tool === "string" && record.tool.length > 0
        ? record.tool
        : typeof record.name === "string" && record.name.length > 0
        ? record.name
        : "";
    const toolCallId =
      typeof record.toolCallId === "string" && record.toolCallId.length > 0
        ? record.toolCallId
        : undefined;
    const entry = toolCallId ? results?.get(toolCallId) : undefined;
    const timed =
      entry !== undefined &&
      typeof entry.startedAtMs === "number" &&
      typeof entry.settledAtMs === "number";
    records.push({
      index,
      toolName,
      ...(toolCallId ? { toolCallId } : {}),
      arguments: record.arguments,
      ...(entry
        ? {
            result: {
              ...normalizeFrictionResult(entry.raw),
              // OR, never overwrite: the payload's own `isError` still counts
              // when the producer said nothing.
              ...(entry.isError === true ? { isError: true } : {}),
            },
          }
        : {}),
      resultAvailable: entry !== undefined,
      ...(timed
        ? {
            startedAtMs: entry.startedAtMs as number,
            settledAtMs: entry.settledAtMs as number,
          }
        : {}),
      ordering:
        entry === undefined ? "unknown" : timed ? "timed" : "messageOrder",
    });
  }
  return records;
}

// ── the deriver ──────────────────────────────────────────────────────────────

function notMeasured(
  reason: FrictionNotMeasuredReason,
  counts: {
    callCount: number;
    resultAvailableCount: number;
    timedCallCount: number;
  }
): EvalTrialFrictionSignals {
  return validate({
    version: FRICTION_SIGNALS_VERSION,
    state: "notMeasured",
    notMeasuredReason: reason,
    ...counts,
    identifierSignals: { state: "notMeasured", reason },
    signals: [],
  });
}

function validate(document: unknown): EvalTrialFrictionSignals {
  const parsed = evalTrialFrictionSignalsSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(
      `deriveTrialFrictionSignals produced an invalid document: ${parsed.error.message}`
    );
  }
  return parsed.data;
}

const KIND_ORDER = new Map<FrictionSignalKind, number>(
  FRICTION_SIGNAL_KINDS.map((kind, index) => [kind, index])
);

function compareSignals(a: FrictionSignal, b: FrictionSignal): number {
  const observation =
    frictionSignalObservationIndex(a) - frictionSignalObservationIndex(b);
  if (observation !== 0) return observation;
  const kind = (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0);
  if (kind !== 0) return kind;
  const anchorA =
    a.kind === "identifierSurfacedUnused" ||
    a.kind === "searchRepeatedAfterIdentifier"
      ? a.informationCallIndex
      : a.priorCallIndex;
  const anchorB =
    b.kind === "identifierSurfacedUnused" ||
    b.kind === "searchRepeatedAfterIdentifier"
      ? b.informationCallIndex
      : b.priorCallIndex;
  if (anchorA !== anchorB) return anchorA - anchorB;
  return a.toolName < b.toolName ? -1 : a.toolName > b.toolName ? 1 : 0;
}

/**
 * Derive one trial's friction signals from its call records.
 *
 * Order is load-bearing:
 *
 *   1. no calls, or more than {@link MAX_FRICTION_CALLS} of them → the whole
 *      document is `notMeasured`;
 *   2. canonicalize every argument object once — a value that cannot be
 *      canonicalized (a cycle, a class instance, a non-finite number) makes
 *      the document `evidenceIncomplete` rather than skipping the call, since
 *      skipping would renumber every index after it;
 *   3. adjacency signals, which need nothing but the graded array;
 *   4. identifier signals, only when every call retained a result AND every
 *      call shares one known ordering mode;
 *   5. sort by the call that made each signal observable, then cap.
 */
export function deriveTrialFrictionSignals(
  records: readonly FrictionCallRecord[]
): EvalTrialFrictionSignals {
  const callCount = records.length;
  const resultAvailableCount = records.filter(
    (record) => record.resultAvailable
  ).length;
  const timedCallCount = records.filter(
    (record) => record.ordering === "timed"
  ).length;
  const counts = { callCount, resultAvailableCount, timedCallCount };

  if (callCount === 0) return notMeasured("noToolCalls", counts);
  if (callCount > MAX_FRICTION_CALLS) return notMeasured("truncated", counts);

  const canonicalArguments: string[] = [];
  for (const record of records) {
    try {
      canonicalArguments.push(canonicalJson(record.arguments ?? null));
    } catch (error) {
      if (error instanceof CanonicalJsonError) {
        return notMeasured("evidenceIncomplete", counts);
      }
      throw error;
    }
  }

  const signals: FrictionSignal[] = [];

  // ── 3. adjacency ───────────────────────────────────────────────────────
  for (let index = 1; index < records.length; index += 1) {
    const prior = records[index - 1]!;
    const current = records[index]!;
    if (prior.toolName !== current.toolName || prior.toolName.length === 0) {
      continue;
    }
    const afterError = prior.result?.isError === true;
    if (canonicalArguments[index - 1] === canonicalArguments[index]) {
      signals.push({
        kind: "identicalRetry",
        callIndex: current.index,
        priorCallIndex: prior.index,
        toolName: current.toolName,
        afterError,
      });
      continue;
    }
    const paginationKeys = changedPaginationKeys(
      prior.arguments,
      current.arguments
    );
    const sameBeyondPagination =
      canonicalJsonOrNull(withoutPaginationKeys(prior.arguments)) ===
      canonicalJsonOrNull(withoutPaginationKeys(current.arguments));
    if (sameBeyondPagination && paginationKeys.length > 0) {
      signals.push({
        kind: "paginationContinuation",
        callIndex: current.index,
        priorCallIndex: prior.index,
        toolName: current.toolName,
        paginationKeys: paginationKeys.slice(0, MAX_PAGINATION_KEYS),
      });
      continue;
    }
    signals.push({
      kind: "changedRetry",
      callIndex: current.index,
      priorCallIndex: prior.index,
      toolName: current.toolName,
      afterError,
    });
  }

  // ── 4. identifier signals ──────────────────────────────────────────────
  let identifierSignals: FrictionIdentifierSignals = { state: "measured" };
  if (resultAvailableCount !== callCount) {
    identifierSignals = { state: "notMeasured", reason: "resultsUnavailable" };
  } else {
    const modes = new Set(records.map((record) => record.ordering));
    if (modes.size !== 1 || modes.has("unknown")) {
      identifierSignals = { state: "notMeasured", reason: "orderingUnknown" };
    }
  }

  if (identifierSignals.state === "measured") {
    for (let position = 0; position < records.length; position += 1) {
      const information = records[position]!;
      // A record whose tool name could not be read cannot be reported: the
      // signal schema requires one, and emitting an empty name would make
      // `validate` throw and lose the whole document — including the
      // adjacency signals, which are unaffected by the missing name.
      if (information.toolName.length === 0) continue;
      const result = information.result;
      if (!result || result.isError) continue;
      const identifiers = extractResultIdentifiers(result);
      if (identifiers.values.length === 0) continue;
      // An incomplete candidate set cannot support a claim about what a later
      // call did NOT use. Withheld for this call only — the trial keeps its
      // adjacency signals and its other calls' identifier signals.
      if (identifiers.truncated) continue;

      // Positions, not `record.index`: the canonical-argument array is built
      // by position, and only the OUTPUT speaks in call indexes.
      const later: number[] = [];
      for (let other = 0; other < records.length; other += 1) {
        if (other === position) continue;
        if (availableBefore(information, records[other]!)) later.push(other);
      }
      if (later.length === 0) continue;

      const used = later.some((other) =>
        identifiers.values.some((value) =>
          argumentsCarryToken(canonicalArguments[other]!, value)
        )
      );
      if (used) continue;

      const keyPaths = identifiers.keyPaths.slice(0, MAX_IDENTIFIER_KEY_PATHS);
      const identifierCount = identifiers.values.length;
      const informationArguments = canonicalJsonOrNull(
        withoutPaginationKeys(information.arguments)
      );

      // THE OBSERVATION INDEX, and why it can fail to exist.
      //
      // `later` is "later in the ordering that established availability",
      // which for a TIMED trial is time, not array position — and the graded
      // array appends wire-only calls, so a call that ran first can sit last.
      // When the information call is one of those appended calls, every call
      // later IN TIME can sit at a LOWER array index than it does.
      //
      // The signal reports an ARRAY index because that is what a reader
      // clicks and what the judge slices (`slice(0, observedAt + 1)`), and an
      // array prefix that ends before the information call cannot express
      // "observed after it". So the signal is DROPPED for that trial rather
      // than emitted invalid: an invalid one fails the document's own
      // validator, and the throw would cost the trial its adjacency signals
      // too — which never depended on timing and are perfectly good.
      const observedAt = observationIndexAfter(records, later, information);
      if (later.length >= 2 && observedAt !== undefined) {
        signals.push({
          kind: "identifierSurfacedUnused",
          informationCallIndex: information.index,
          observedAtCallIndex: observedAt,
          toolName: information.toolName,
          ...(information.toolCallId
            ? { toolCallId: information.toolCallId }
            : {}),
          identifierKeyPaths: keyPaths,
          identifierCount,
          laterCallCount: later.length,
        });
      }

      const repeats = later.filter((other) => {
        const candidate = records[other]!;
        return (
          candidate.toolName === information.toolName &&
          canonicalJsonOrNull(withoutPaginationKeys(candidate.arguments)) !==
            informationArguments
        );
      });
      const repeatObservedAt = observationIndexAfter(
        records,
        repeats,
        information
      );
      if (repeats.length > 0 && repeatObservedAt !== undefined) {
        // Only the repeats the observation index can actually cover: a repeat
        // at a lower array index than the information call is real but
        // unaddressable in this shape, and naming it would contradict the
        // document's own "a repeat cannot fall after the observation index".
        const addressable = repeats
          .map((other) => records[other]!.index)
          .filter((index) => index > information.index)
          .sort((left, right) => left - right);
        signals.push({
          kind: "searchRepeatedAfterIdentifier",
          informationCallIndex: information.index,
          observedAtCallIndex: repeatObservedAt,
          toolName: information.toolName,
          ...(information.toolCallId
            ? { toolCallId: information.toolCallId }
            : {}),
          repeatCallIndexes: addressable.slice(0, MAX_REPEAT_CALL_INDEXES),
          identifierKeyPaths: keyPaths,
          identifierCount,
        });
      }
    }
  }

  // ── 5. order, cap ──────────────────────────────────────────────────────
  signals.sort(compareSignals);

  return validate({
    version: FRICTION_SIGNALS_VERSION,
    state: "measured",
    ...counts,
    identifierSignals,
    signals: capSignals(signals),
  });
}

/**
 * Cap the signal list WITHOUT losing a kind.
 *
 * A plain `slice(0, 24)` would drop whole kinds: a trial that paginated
 * thirty times and surfaced one unused identifier at the end would keep
 * twenty-four `paginationContinuation` rows and lose the one signal anybody
 * wanted. Worse, the case-level rates count the KIND SET of each trial
 * (`route-facts.ts`), so a kind cut by the cap reads as "did not fire" while
 * the trial stays in the denominator — a rate that silently understates.
 *
 * So the first pass reserves one slot per kind that fired, earliest first,
 * and the remaining slots fill in order. The result is re-sorted, because the
 * document's ordering invariant is by observation index and reservation
 * breaks it.
 */
function capSignals(signals: readonly FrictionSignal[]): FrictionSignal[] {
  if (signals.length <= MAX_FRICTION_SIGNALS) return [...signals];
  const keptPositions = new Set<number>();
  const seenKinds = new Set<FrictionSignalKind>();
  for (const [position, signal] of signals.entries()) {
    if (seenKinds.has(signal.kind)) continue;
    seenKinds.add(signal.kind);
    keptPositions.add(position);
    if (keptPositions.size >= MAX_FRICTION_SIGNALS) break;
  }
  for (const [position] of signals.entries()) {
    if (keptPositions.size >= MAX_FRICTION_SIGNALS) break;
    keptPositions.add(position);
  }
  return [...keptPositions]
    .sort((left, right) => left - right)
    .map((position) => signals[position]!)
    .sort(compareSignals);
}

/**
 * The array index a signal can honestly point at as "where this became
 * observable", or `undefined` when no such index exists.
 *
 * The highest array index among the observing calls, and only when it is
 * AFTER the information call. See the call site for why that can fail on a
 * timed trial, and why the answer there is to drop one signal rather than
 * emit an invalid document.
 */
function observationIndexAfter(
  records: readonly FrictionCallRecord[],
  positions: readonly number[],
  information: FrictionCallRecord
): number | undefined {
  let highest: number | undefined;
  for (const position of positions) {
    const index = records[position]!.index;
    if (index <= information.index) continue;
    if (highest === undefined || index > highest) highest = index;
  }
  return highest;
}

/**
 * Canonicalize, or return `null` for a value that cannot be.
 *
 * Only reached AFTER the whole-record canonicalization above has already
 * proven every argument object canonicalizable, so the null arm is
 * unreachable in practice; it exists so a pagination comparison can never be
 * the thing that throws out of a derivation.
 */
function canonicalJsonOrNull(value: unknown): string | null {
  try {
    return canonicalJson(value ?? null);
  } catch {
    return null;
  }
}

/**
 * The trial's friction signals, built from a graded call array and whatever
 * results the producer retained.
 *
 * The single call site a producer needs: it never throws for evidence
 * reasons — an uncanonicalizable argument or a missing result becomes a
 * `notMeasured` document — so a finalize path can stamp the result without a
 * fallback of its own.
 */
export function deriveTrialFrictionSignalsFromCalls(args: {
  toolsCalled: readonly unknown[];
  resultsByToolCallId?: ReadonlyMap<string, FrictionResultEntry>;
  /**
   * A hole the PRODUCER knows about and this module cannot see — a harness
   * turn whose evidence read came back incomplete, say. Set it and the whole
   * document is `notMeasured` for that reason, with the call counts still
   * reported honestly: "we could not measure these five calls" is a different
   * statement from "there were no calls".
   */
  evidenceHole?: FrictionNotMeasuredReason;
}): EvalTrialFrictionSignals {
  const records = buildFrictionCallRecords(args);
  if (args.evidenceHole) {
    return notMeasured(args.evidenceHole, {
      callCount: records.length,
      resultAvailableCount: records.filter((record) => record.resultAvailable)
        .length,
      timedCallCount: records.filter((record) => record.ordering === "timed")
        .length,
    });
  }
  return deriveTrialFrictionSignals(records);
}

// ── projection ───────────────────────────────────────────────────────────────

/**
 * Public projection of an iteration's friction signals.
 *
 * Mirrors `projectStageDerivation`: `metadata` is an open record, only this
 * whitelist crosses the boundary, a validated document passes through, an
 * invalid one becomes `frictionSignalsUnverified`, and metadata that predates
 * the measurement is OMITTED so those iterations stay byte-identical — an
 * absent block means "never measured", never "measured zero".
 */
export function projectFrictionSignals(
  metadata: unknown
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const record = metadata as Record<string, unknown>;
  if (!("frictionSignals" in record)) return {};
  const parsed = evalTrialFrictionSignalsSchema.safeParse(
    record.frictionSignals
  );
  if (parsed.success) return { frictionSignals: parsed.data };
  return { frictionSignalsUnverified: true };
}

// ── the suspected condition (step 2's advisory verdict) ──────────────────────

/**
 * The closed taxonomy step 2's judge may name, mirrored from the backend's
 * `convex/lib/suspectedConditionGeneration.ts` (pinned as
 * `eval-suspected-conditions` in `convex/lib/mirrors.json`).
 *
 * SAFE VALUE FIRST. `unclear` is what every demotion on the backend lands on —
 * a low-confidence verdict, an unknown condition, a remediation that named no
 * server lever — so the safe answer is also the first member here.
 *
 * SUSPECTED, and the word stays. Repetition tells a run apart from noise; only
 * an intervention (step 3's controlled rewrite) tells the server apart from
 * the model. Nothing in this block is evidence that a condition CAUSED
 * anything, and the labels in `decision-labels.ts` never say it did.
 */
export const SUSPECTED_CONDITIONS = [
  "unclear",
  "idBuriedInPayload",
  "idNameCollision",
  "missingQueryEcho",
  "silentTruncation",
  "ambiguousErrorSemantics",
  "missingUnits",
  "responseWasClear",
  "descriptionMisleading",
] as const;
export type SuspectedCondition = (typeof SUSPECTED_CONDITIONS)[number];
export const suspectedConditionSchema = z.enum(SUSPECTED_CONDITIONS);
export function isSuspectedCondition(
  value: unknown
): value is SuspectedCondition {
  return (
    typeof value === "string" &&
    (SUSPECTED_CONDITIONS as readonly string[]).includes(value)
  );
}

export const SUSPECTED_CONDITION_CONFIDENCES = [
  "low",
  "medium",
  "high",
] as const;
export type SuspectedConditionConfidence =
  (typeof SUSPECTED_CONDITION_CONFIDENCES)[number];
export const suspectedConditionConfidenceSchema = z.enum(
  SUSPECTED_CONDITION_CONFIDENCES
);

/** Why a flagged trial produced no verdict. */
export const SUSPECTED_CONDITION_SKIP_REASONS = [
  "spendBlocked",
  "traceIncomplete",
  "noEvidence",
  "cap",
] as const;
export type SuspectedConditionSkipReason =
  (typeof SUSPECTED_CONDITION_SKIP_REASONS)[number];

/** Remediation and field-path caps, mirroring the judge's own. */
export const MAX_SUSPECTED_CONDITION_REMEDIATION_CHARS = 300;
export const MAX_SUSPECTED_CONDITION_FIELD_PATH_CHARS = 120;

const suspectedConditionEvidenceSchema = z
  .object({
    callIndex: z.number().int().min(0),
    toolName: z.string().min(1),
    fieldPath: z
      .string()
      .min(1)
      .max(MAX_SUSPECTED_CONDITION_FIELD_PATH_CHARS)
      .optional(),
  })
  .strict();
export type SuspectedConditionEvidence = z.infer<
  typeof suspectedConditionEvidenceSchema
>;

const suspectedConditionProvenance = {
  /** `${caseKey}#${iterationNumber}`, the judge's join key. */
  gradingKey: z.string().min(1),
  /** Which friction signal triggered the judge, and the window it saw. */
  signalKind: z.string().min(1),
  informationCallIndex: z.number().int().min(0),
  observedAtCallIndex: z.number().int().min(0),
  judgeTemplateVersion: z.number().int().min(1),
  judgeTemplateHash: z.string().min(1),
  model: z.string().min(1),
  generatedAt: z.number().int().min(0),
};

/**
 * One trial's suspected-condition verdict, discriminated on `status`.
 *
 * `skipped` and `error` are real outcomes and carry no condition: a reader
 * that saw `condition: "unclear"` for a trial the judge never reached could
 * not tell "we looked and could not say" from "we never looked".
 */
export const suspectedConditionVerdictSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("scored"),
      condition: suspectedConditionSchema,
      confidence: suspectedConditionConfidenceSchema,
      remediation: z
        .string()
        .min(1)
        .max(MAX_SUSPECTED_CONDITION_REMEDIATION_CHARS)
        .optional(),
      evidence: suspectedConditionEvidenceSchema.optional(),
      ...suspectedConditionProvenance,
    })
    .strict(),
  z
    .object({
      status: z.literal("skipped"),
      reason: z.enum(SUSPECTED_CONDITION_SKIP_REASONS),
      ...suspectedConditionProvenance,
    })
    .strict(),
  z
    .object({
      status: z.literal("error"),
      ...suspectedConditionProvenance,
    })
    .strict(),
]);
export type SuspectedConditionVerdict = z.infer<
  typeof suspectedConditionVerdictSchema
>;

/**
 * Public projection of an iteration's suspected-condition verdict.
 *
 * Same three-way shape `projectFrictionSignals` uses: absent stays absent
 * (the trial predates the judge, or the judge never ran for it), a valid
 * verdict passes through, and an invalid one becomes
 * `suspectedConditionUnverified` rather than being partially trusted — a
 * half-read attribution rendered as a named server condition is worse than
 * none.
 */
export function projectSuspectedConditionVerdict(
  metadata: unknown
): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object") return {};
  const record = metadata as Record<string, unknown>;
  if (!("suspectedConditionVerdict" in record)) return {};
  const parsed = suspectedConditionVerdictSchema.safeParse(
    record.suspectedConditionVerdict
  );
  if (parsed.success) return { suspectedConditionVerdict: parsed.data };
  return { suspectedConditionUnverified: true };
}
