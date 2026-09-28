/**
 * The canonical **eval run server facts** — one versioned shape describing the
 * SERVER SNAPSHOT a run was taken against, and what the setup phase observed.
 *
 * Browser-safe; no node-only deps.
 *
 * ── WHAT A FACT IS, AND WHY NONE OF THIS IS A CHECK ──────────────────────────
 *
 * Three dimensions decide what an observation may claim, and they are
 * independent: its SCOPE (what it is about), its METHOD (how it was decided),
 * and its POLICY (what it does to the verdict). Everything in this document is
 * scoped to the SNAPSHOT or the RUN, measured or validated, and carries NO
 * policy at all. A tool surface of 57 tools is not a defect; a connection that
 * took 3 seconds is not a failure; a description with no parameter docs is a
 * signal, not a violation. Facts are shown beside a run and never become a
 * stage state.
 *
 * ── THREE PAYLOAD SIZES, NEVER MIXED ─────────────────────────────────────────
 *
 * The one number everybody wants — "how much context does this server eat?" —
 * is three different numbers, and conflating them is how a report ends up
 * confidently wrong:
 *
 *   1. the AGGREGATED CATALOG as the client assembled it, measured at capture
 *      (`aggregated_catalog_json`). The client manager pages `tools/list`
 *      internally and hands back one merged `ListToolsResult`, so this is the
 *      assembled catalog and NOT the wire responses — hence the name. Per-page
 *      wire bytes need a transport hook and are deliberately out of scope; a
 *      future basis can be added without moving this one.
 *   2. the bytes RETAINED in the normalized snapshot
 *      (`normalized_snapshot`), which is smaller whenever the archive dropped
 *      fields — and says so through `complete: false`.
 *   3. what the MODEL actually saw, which is a per-run HOST fact
 *      (`tools_exposed`) and not a byte count at all. It is not in this
 *      document, and nothing here should be read as it.
 *
 * Tokens are always an ESTIMATE and always labelled one. There is no tokenizer
 * in this stack; `json_chars_div_4` is a documented approximation, and the
 * share it is reported against is a REFERENCE window, not a measurement of
 * anybody's context.
 *
 * ── RELATED ASSESSMENTS ARE LINKED, NOT GRADED ───────────────────────────────
 *
 * Conformance and readiness runs are joined by server id ALONE. A different
 * server version, environment or auth context is not excluded by that join, so
 * every entry carries its own timestamp and states the comparability it can
 * honestly claim. None of them is this run's verdict.
 *
 * ── No `.default()`, every object `.strict()` ────────────────────────────────
 *
 * Same discipline as `./route-facts.ts`: an omitted field stays omitted so the
 * payload is byte-stable, and an unknown field is an error rather than a
 * silent passenger.
 */

import { z } from "zod";

/**
 * The document shape. Bump when the SHAPE changes; a reader compares.
 */
export const SERVER_FACTS_SCHEMA_VERSION = 1;

/**
 * How the facts were DERIVED. Bump when the same inputs would now produce
 * different numbers — a changed precheck, a new payload basis — so a stored
 * document can be re-derived selectively rather than wholesale.
 */
export const SERVER_FACTS_SOURCE_VERSION = 1;

/** Caps, so one pathological snapshot cannot inflate every document. */
export const MAX_SERVER_FACTS_SERVERS = 50;
export const MAX_SERVER_FACTS_PRECHECKS = 500;
export const MAX_SERVER_FACTS_RELATED = 8;

/**
 * The token estimator, named in the payload so a reader never has to guess
 * which one produced a number.
 *
 * `json_chars_div_4` — characters of the serialized JSON divided by four.
 * CHARACTERS, not bytes: a catalog full of non-ASCII would otherwise be
 * double-counted by UTF-8's multi-byte encoding, inflating the estimate for
 * exactly the servers whose descriptions are not in English.
 */
export const SERVER_FACTS_TOKEN_METHOD = "json_chars_div_4" as const;

/**
 * The window a share is reported against. A REFERENCE, not a measurement:
 * nothing here knows the model a run used or what else was in its context.
 */
export const SERVER_FACTS_REFERENCE_WINDOW_TOKENS = 200_000;

/** Why a document has no server rows to show. */
export const SERVER_FACTS_UNAVAILABLE_REASONS = [
  /** The run predates snapshot capture, or its snapshot was purged. */
  "snapshotMissing",
  /** Capture ran and did not finish; complete servers are still listed. */
  "snapshotPartial",
  /** No iteration carried the run-level setup audit. */
  "setupNotObserved",
] as const;

export type ServerFactsUnavailableReason =
  (typeof SERVER_FACTS_UNAVAILABLE_REASONS)[number];

/** What a payload byte count was measured on. See the module docblock. */
export const SERVER_FACTS_PAYLOAD_BASES = [
  "aggregated_catalog_json",
  "normalized_snapshot",
] as const;

export type ServerFactsPayloadBasis =
  (typeof SERVER_FACTS_PAYLOAD_BASES)[number];

/** Deterministic precheck classes, mirrored from the backend's vocabulary. */
export const SERVER_FACTS_PRECHECK_CLASSES = [
  "spec_required",
  "spec_recommended",
  "quality_signal",
] as const;

export type ServerFactsPrecheckClass =
  (typeof SERVER_FACTS_PRECHECK_CLASSES)[number];

/** A setup phase's outcome. Mirrors `StageSetupPhaseSignal`. */
export const serverFactsSetupPhaseSchema = z
  .object({
    outcome: z.enum(["ok", "failed"]),
    /** Present on a failure only. Never "theirs" without positive evidence. */
    attribution: z.enum(["ours", "theirs", "unknown"]).optional(),
    /** Positive canary evidence that our own egress works. */
    egressVerified: z.boolean().optional(),
    /**
     * The phase's wall-clock envelope. A RUN-LEVEL number, counted once per
     * run and phase — a run with 200 trials did not connect 200 times.
     */
    durationMs: z.number().int().nonnegative().optional(),
    basis: z.literal("setup_phase_wall"),
  })
  .strict();

/**
 * The sentence that must travel with every token number this document carries.
 *
 * Exported rather than restated at each render site: a caption that says
 * "estimate" in one surface and not another is how a reader learns to treat
 * the number as measured.
 */
export const SERVER_FACTS_TOKEN_NOTE =
  "estimate of a reference window, not measured context consumption";

export const serverFactsPrecheckSchema = z
  .object({
    toolName: z.string().min(1),
    code: z.string().min(1),
    class: z.enum(SERVER_FACTS_PRECHECK_CLASSES),
    /**
     * Numbers only, by the producer's discipline — never free text.
     *
     * The KEYS are bounded too. A precheck row reaches an LLM judge prompt,
     * and "values are numbers" does not stop a sentence from riding in as a
     * property name.
     */
    detail: z
      .record(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), z.number())
      .optional(),
    /**
     * True when whether this is a finding at all depends on the protocol
     * version, and the version was not known. Rendered as "depends on protocol
     * version", never as a violation.
     */
    protocolDependent: z.boolean().optional(),
  })
  .strict();

export const serverFactsRelatedAssessmentSchema = z
  .object({
    kind: z.enum(["conformance", "readiness"]),
    /** Absent when the assessment has no addressable route. */
    runId: z.string().min(1).optional(),
    createdAt: z.number().int().nonnegative(),
    protocolVersion: z.string().min(1).optional(),
    serverVersion: z.string().min(1).optional(),
    /**
     * The ONLY thing the join establishes. A different server version,
     * environment or auth context is not excluded by it, so the label says
     * what was matched rather than implying the assessment describes this run.
     */
    comparability: z.literal("sameServerId"),
  })
  .strict();

export const serverFactsPayloadSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    basis: z.enum(SERVER_FACTS_PAYLOAD_BASES),
    /** False when fields were dropped before the measurement was taken. */
    complete: z.boolean(),
  })
  .strict();

export const serverFactsServerSchema = z
  .object({
    serverId: z.string().min(1),
    /** `failed` ⇒ this server's numbers are absent, not zero. */
    capture: z.enum(["complete", "failed"]),
    toolCount: z.number().int().nonnegative(),
    payload: serverFactsPayloadSchema,
    /** An ESTIMATE. See `SERVER_FACTS_TOKEN_METHOD`. */
    estimatedTokens: z.number().int().nonnegative(),
    /** Estimated tokens as a share of the REFERENCE window, 0..1. */
    referenceWindowShare: z.number().min(0),
    annotations: z
      .object({
        total: z.number().int().nonnegative(),
        withReadOnlyHint: z.number().int().nonnegative(),
        withDestructiveHint: z.number().int().nonnegative(),
      })
      .strict()
      // A subset cannot outnumber the set it is drawn from. Serving "41 of 12
      // tools declare readOnlyHint" is not a small inaccuracy — it tells a
      // reader the coverage number in front of them means nothing.
      .refine(
        (a) => a.withReadOnlyHint <= a.total && a.withDestructiveHint <= a.total,
        { message: "annotation counts cannot exceed the tool total" }
      ),
    outputSchema: z
      .object({
        total: z.number().int().nonnegative(),
        present: z.number().int().nonnegative(),
      })
      .strict()
      .refine((o) => o.present <= o.total, {
        message: "outputSchema.present cannot exceed the tool total",
      }),
    prechecks: z.array(serverFactsPrecheckSchema).max(MAX_SERVER_FACTS_PRECHECKS),
    relatedAssessments: z
      .array(serverFactsRelatedAssessmentSchema)
      .max(MAX_SERVER_FACTS_RELATED),
  })
  .strict();

export const evalRunServerFactsSchema = z
  .object({
    schemaVersion: z.literal(SERVER_FACTS_SCHEMA_VERSION),
    sourceVersion: z.literal(SERVER_FACTS_SOURCE_VERSION),
    runId: z.string().min(1),
    suiteId: z.string().min(1),
    computedAt: z.number().int().nonnegative(),
    /** `unavailable` carries a reason and may still list complete servers. */
    state: z.enum(["ready", "unavailable"]),
    reason: z.enum(SERVER_FACTS_UNAVAILABLE_REASONS).optional(),
    /** The negotiated MCP protocol version, when the snapshot recorded it. */
    protocolVersion: z.string().min(1).optional(),
    tokenEstimate: z
      .object({
        method: z.literal(SERVER_FACTS_TOKEN_METHOD),
        referenceWindowTokens: z.literal(
          SERVER_FACTS_REFERENCE_WINDOW_TOKENS
        ),
        // The literal, not any string: the caveat is what stops a reader
        // taking an estimate for a measurement, so a producer that rewrote it
        // would still validate while removing the one thing the field is for.
        note: z.literal(SERVER_FACTS_TOKEN_NOTE),
      })
      .strict(),
    setup: z
      .object({
        connection: serverFactsSetupPhaseSchema.optional(),
        discovery: serverFactsSetupPhaseSchema.optional(),
      })
      .strict(),
    servers: z.array(serverFactsServerSchema).max(MAX_SERVER_FACTS_SERVERS),
  })
  .strict()
  // `state` and `reason` are one fact, and the schema says so. An
  // `unavailable` document with no reason gives a reader nothing to act on;
  // a `ready` one carrying a reason invites the card to render an excuse for
  // measurements that were, in fact, taken.
  .refine((doc) => (doc.state === "unavailable") === (doc.reason !== undefined), {
    message:
      "`reason` is required exactly when `state` is \"unavailable\"",
    path: ["reason"],
  });

export type EvalRunServerFactsV1 = z.infer<typeof evalRunServerFactsSchema>;
export type ServerFactsSetupPhase = z.infer<typeof serverFactsSetupPhaseSchema>;
export type ServerFactsPrecheck = z.infer<typeof serverFactsPrecheckSchema>;
export type ServerFactsServer = z.infer<typeof serverFactsServerSchema>;
export type ServerFactsRelatedAssessment = z.infer<
  typeof serverFactsRelatedAssessmentSchema
>;


/**
 * Estimated tokens as a share of the reference window.
 *
 * THE ONLY WAY A RATE IS MINTED IN THIS DOCUMENT. Every other number is a
 * count or a measurement, and a rate computed ad hoc at a render site is a
 * rate with an undocumented denominator — which is the shape most misleading
 * "% of context" figures take.
 */
export function referenceWindowShare(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return tokens / SERVER_FACTS_REFERENCE_WINDOW_TOKENS;
}

/**
 * The token estimate for a serialized value, by the documented method.
 *
 * Characters, not bytes — see `SERVER_FACTS_TOKEN_METHOD`.
 */
export function estimateTokensFromJson(json: string): number {
  return Math.ceil(json.length / 4);
}

/** Parse a stored document, or explain why it is not one. */
export function parseEvalRunServerFacts(value: unknown): EvalRunServerFactsV1 {
  return evalRunServerFactsSchema.parse(value);
}
