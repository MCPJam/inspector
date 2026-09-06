/**
 * Model-backed experience observations, and the wall between them and a
 * verdict.
 *
 * WHAT AN OBSERVATION IS. A bounded sentence a language model produced after
 * reading evidence THIS run already gathered: "the tool descriptions repeat
 * the product name in every entry", "two skills describe the same task". It is
 * a reading, not a measurement, and it is worth surfacing precisely because
 * the deterministic graders cannot produce it.
 *
 * WHAT AN OBSERVATION IS NOT, and this is the entire reason this module exists
 * rather than a `parse()` call at each call site:
 *
 *   - it is not a finding. The model returns observation IDs from a frozen
 *     catalogue; the SDK — pure, offline, testable — decides what finding each
 *     ID becomes.
 *   - it is not a requirement. A model cannot invent an ID, so it cannot
 *     invent a rule to grade against.
 *   - it is not dispositive. Every finding this module produces lands in the
 *     publisher's experience lane as `heuristic` or `manual-review`, which
 *     `decideLaneStatus` already ignores. {@link mapObservationsToFindings}
 *     re-checks that at runtime rather than trusting the catalogue's author.
 *   - it is not evidence. `provenance` is `llm`, so a reader can always see
 *     that a model, not the wire, is behind the line.
 *
 * WHY THE FAILURE PATH IS A FIRST-CLASS TYPE. Every way this can go wrong —
 * the provider erred, the org is out of credits, the model returned something
 * that did not validate, nobody asked for observations at all — has to arrive
 * at the reader as an explicit `not-evaluated` state with a machine-readable
 * reason. A billing denial that silently produced no observations would be
 * indistinguishable from a model that found nothing to say, and "we could not
 * afford to look" must never render as "we looked and it was fine". Equally,
 * none of these states may make the TARGET fail: a payment problem is the
 * account's, not the server's.
 *
 * Pure data reasoning: no transport, no provider SDK, no Node built-ins. Safe
 * from the browser entry, which is what lets a UI render an observation and
 * its billing status without being able to request one.
 */

import { createFindingConstructors } from "./helpers.js";
import type {
  DirectoryCheckDefinition,
  DirectoryCheckStamp,
} from "./helpers.js";
import type {
  DirectoryFindingClass,
  DirectoryReadinessFinding,
} from "./types.js";

/**
 * The only two classes an AI-derived finding may carry.
 *
 * Both are ignored by {@link import("./types.js").decideLaneStatus}, so a
 * finding constrained to them cannot decide a lane however it is worded. The
 * constraint is a runtime list rather than only a type because a catalogue can
 * be assembled from data, and a `class` that arrived as a string would satisfy
 * the compiler on its way to deciding a required lane.
 */
export const DIRECTORY_OBSERVATION_FINDING_CLASSES = [
  "heuristic",
  "manual-review",
] as const satisfies readonly DirectoryFindingClass[];

export type DirectoryObservationFindingClass =
  (typeof DIRECTORY_OBSERVATION_FINDING_CLASSES)[number];

/**
 * How sure the model says it is.
 *
 * Three coarse buckets, never a number. A percentage invites arithmetic —
 * averaging confidences, thresholding on them, ranking findings by them — and
 * every one of those operations treats a model's self-report as a calibrated
 * probability, which it is not. Buckets can be displayed and sorted and
 * nothing else, which is all this deserves.
 *
 * NO ADAPTER MAY REINTERPRET THIS. A surface that promoted `high` to a
 * violation would have re-derived a verdict from an opinion, which is the one
 * thing this module exists to prevent.
 */
export const DIRECTORY_OBSERVATION_CONFIDENCE = [
  "low",
  "medium",
  "high",
] as const;

export type DirectoryObservationConfidence =
  (typeof DIRECTORY_OBSERVATION_CONFIDENCE)[number];

/**
 * Why a run holds no model observations, as an independent axis from the run's
 * own status.
 *
 * INDEPENDENT IS THE POINT. A run whose deterministic lanes all graded cleanly
 * is a COMPLETED run even when the observation call was refused for credit, and
 * collapsing the two would either fail a healthy run over a billing problem or
 * hide the billing problem inside a green result.
 *
 *   - `not-requested` — the caller did not ask. The default, and free.
 *   - `pending` — asked for, not yet answered. Only ever seen mid-run.
 *   - `completed` — a validated envelope is attached.
 *   - `billing-blocked` — the reservation was denied before any provider call.
 *     No model ran, so nothing was charged.
 *   - `provider-failed` — the provider errored or timed out.
 *   - `invalid-output` — the provider answered and the answer did not validate
 *     against the schema. Deliberately distinct from `provider-failed`: one is
 *     an outage and the other is a prompt/schema defect, and they are fixed by
 *     different people.
 */
export const DIRECTORY_OBSERVATION_STATUSES = [
  "not-requested",
  "pending",
  "completed",
  "billing-blocked",
  "provider-failed",
  "invalid-output",
] as const;

export type DirectoryObservationStatus =
  (typeof DIRECTORY_OBSERVATION_STATUSES)[number];

/**
 * Machine-readable reasons, so a surface can BRANCH rather than string-match a
 * human sentence.
 *
 * `billing_limit_reached` is the load-bearing one: it is the value a UI keys
 * on to offer a top-up, and the value a CLI keys on for its distinct exit
 * code. Renaming it is a breaking change to three surfaces at once.
 */
export const DIRECTORY_OBSERVATION_REASONS = [
  "not_requested",
  "billing_limit_reached",
  "provider_error",
  "provider_timeout",
  "schema_invalid",
  "no_evidence",
  "cancelled",
] as const;

export type DirectoryObservationReason =
  (typeof DIRECTORY_OBSERVATION_REASONS)[number];

/** One thing the model said, after validation. */
export interface DirectoryObservation<Id extends string = string> {
  /**
   * A member of the publisher's frozen catalogue. The model SELECTS; it does
   * not name. An unknown ID is rejected rather than passed through, because a
   * passed-through ID is a requirement the model invented.
   */
  id: Id;
  /** One bounded sentence, rendered verbatim and never parsed for meaning. */
  summary: string;
  confidence: DirectoryObservationConfidence;
  /**
   * Pointers into the evidence the model was shown — a tool name, a skill
   * name, a manifest field. Free-form strings, bounded in count and length,
   * carried so a reader can check the model's homework.
   */
  evidenceRefs: string[];
}

/**
 * A validated batch of observations, stamped with everything needed to
 * reproduce or discredit it later.
 *
 * The four version/identity fields are not bookkeeping. A model's output is
 * only interpretable against the prompt that elicited it and the schema that
 * shaped it; an envelope that cannot say which model, which prompt and which
 * schema produced it becomes an unattributable opinion the moment any of the
 * three moves — and this feature will move all three.
 */
export interface DirectoryObservationEnvelope<
  Kind extends string = string,
  Id extends string = string,
> {
  /** Which publisher's catalogue `observations[].id` are drawn from. */
  readinessKind: string;
  /** Which observation pass this is — publishers may run more than one. */
  observationKind: Kind;
  /** The envelope/catalogue revision. Bumped when IDs or bounds change. */
  observationSchemaVersion: string;
  /** The prompt revision that elicited this. Versioned separately. */
  promptVersion: string;
  /** The provider model ID, exactly as the backend chose it. */
  modelId: string;
  /** ISO-8601, stamped by the backend when the provider answered. */
  observedAt: string;
  observations: DirectoryObservation<Id>[];
}

/**
 * The observation axis of a result, whatever happened on it.
 *
 * ALWAYS PRESENT, including when nobody asked: an absent field reads as "this
 * build has no AI" and a `not-requested` one reads as "you did not ask for
 * it", and only the second is true.
 */
export interface DirectoryObservationState<
  Kind extends string = string,
  Id extends string = string,
> {
  status: DirectoryObservationStatus;
  /** Absent only when `status` is `completed`. */
  reason?: DirectoryObservationReason;
  /** A sentence for a human. Never parsed — branch on `reason`. */
  detail?: string;
  /** Present only when `status` is `completed`. */
  envelope?: DirectoryObservationEnvelope<Kind, Id>;
}

/**
 * Bounds every envelope is held to, before a single ID is looked up.
 *
 * These are REFUSAL thresholds, not truncation thresholds. A model that
 * returned four hundred observations has misunderstood its instructions, and
 * silently keeping the first twenty would ship a report that looked considered
 * and was arbitrary. The whole envelope is rejected, the state becomes
 * `invalid-output`, and the reader is told why.
 */
export const DIRECTORY_OBSERVATION_LIMITS = Object.freeze({
  maxObservations: 24,
  maxSummaryChars: 400,
  maxEvidenceRefs: 8,
  maxEvidenceRefChars: 200,
  maxModelIdChars: 128,
  maxVersionChars: 64,
});

export type DirectoryObservationParseFailure = {
  ok: false;
  /** Always `schema_invalid` today; typed so a caller switches, not guesses. */
  reason: Extract<DirectoryObservationReason, "schema_invalid">;
  /** Names the offending field and what was wrong with it. */
  detail: string;
};

export type DirectoryObservationParseResult<
  Kind extends string,
  Id extends string,
> =
  | { ok: true; envelope: DirectoryObservationEnvelope<Kind, Id> }
  | DirectoryObservationParseFailure;

export interface DirectoryObservationSchema<
  Kind extends string,
  Id extends string,
> {
  /** The publisher discriminator an envelope must carry to be accepted. */
  readinessKind: string;
  /** The observation passes this publisher defines. */
  observationKinds: readonly Kind[];
  /** The frozen catalogue. Anything outside it is rejected. */
  knownIds: readonly Id[];
  /** The revision this SDK build understands. */
  schemaVersion: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function boundedString(
  value: unknown,
  max: number,
): { ok: true; value: string } | { ok: false; why: string } {
  if (typeof value !== "string") return { ok: false, why: "is not a string" };
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, why: "is empty" };
  if (trimmed.length > max) {
    return {
      ok: false,
      why: `is ${trimmed.length} chars, over the ${max} cap`,
    };
  }
  return { ok: true, value: trimmed };
}

function fail(detail: string): DirectoryObservationParseFailure {
  return { ok: false, reason: "schema_invalid", detail };
}

/**
 * Validate raw provider output into an envelope, or refuse it with a reason.
 *
 * TOTAL, never throwing. The caller is a run that must still finish: a bad
 * envelope degrades the observation axis and leaves every deterministic lane
 * exactly as it was, so throwing here would convert a cosmetic gap into a
 * failed readiness run.
 *
 * Validated in the order a reader would ask the questions: is this the right
 * publisher's envelope, does this build understand its schema, is it within
 * bounds, and only then, is every ID one we published. Reversing that order
 * would report "unknown observation id" for output that was never meant for
 * this publisher at all.
 */
export function parseDirectoryObservationEnvelope<
  Kind extends string,
  Id extends string,
>(
  value: unknown,
  schema: DirectoryObservationSchema<Kind, Id>,
): DirectoryObservationParseResult<Kind, Id> {
  const root = asRecord(value);
  if (!root) return fail("the envelope is not a JSON object");

  if (root.readinessKind !== schema.readinessKind) {
    return fail(
      `envelope readinessKind ${JSON.stringify(
        root.readinessKind,
      )} is not ${JSON.stringify(schema.readinessKind)}`,
    );
  }

  const observationKind = root.observationKind;
  if (
    typeof observationKind !== "string" ||
    !(schema.observationKinds as readonly string[]).includes(observationKind)
  ) {
    return fail(
      `observationKind ${JSON.stringify(
        observationKind,
      )} is not one of ${schema.observationKinds.join(", ")}`,
    );
  }

  // AN UNKNOWN SCHEMA VERSION IS A REFUSAL, not a best effort. The version is
  // what says which IDs and which bounds the producer believed in; accepting a
  // version this build has never seen would grade its output against the wrong
  // catalogue and call the mismatch the model's fault.
  if (root.observationSchemaVersion !== schema.schemaVersion) {
    return fail(
      `observationSchemaVersion ${JSON.stringify(
        root.observationSchemaVersion,
      )} is not the ${JSON.stringify(
        schema.schemaVersion,
      )} this build understands`,
    );
  }

  const promptVersion = boundedString(
    root.promptVersion,
    DIRECTORY_OBSERVATION_LIMITS.maxVersionChars,
  );
  if (!promptVersion.ok) return fail(`promptVersion ${promptVersion.why}`);

  const modelId = boundedString(
    root.modelId,
    DIRECTORY_OBSERVATION_LIMITS.maxModelIdChars,
  );
  if (!modelId.ok) return fail(`modelId ${modelId.why}`);

  const observedAt = typeof root.observedAt === "string" ? root.observedAt : "";
  if (!observedAt || Number.isNaN(Date.parse(observedAt))) {
    return fail("observedAt is not an ISO-8601 timestamp");
  }

  if (!Array.isArray(root.observations)) {
    return fail("observations is not an array");
  }
  if (root.observations.length > DIRECTORY_OBSERVATION_LIMITS.maxObservations) {
    return fail(
      `observations holds ${root.observations.length} entries, over the ${DIRECTORY_OBSERVATION_LIMITS.maxObservations} cap`,
    );
  }

  const known = new Set<string>(schema.knownIds);
  const seen = new Set<string>();
  const observations: DirectoryObservation<Id>[] = [];

  for (const [index, entry] of root.observations.entries()) {
    const record = asRecord(entry);
    if (!record) return fail(`observations[${index}] is not an object`);

    const id = record.id;
    if (typeof id !== "string" || !known.has(id)) {
      return fail(
        `observations[${index}].id ${JSON.stringify(
          id,
        )} is not a published observation id`,
      );
    }
    // DUPLICATES ARE REFUSED. Two entries for one ID would render as two
    // findings for one check, and a reader counting lines would see a problem
    // reported twice as a problem twice as large.
    if (seen.has(id)) {
      return fail(
        `observations[${index}].id ${JSON.stringify(id)} is repeated`,
      );
    }
    seen.add(id);

    const summary = boundedString(
      record.summary,
      DIRECTORY_OBSERVATION_LIMITS.maxSummaryChars,
    );
    if (!summary.ok) {
      return fail(`observations[${index}].summary ${summary.why}`);
    }

    const confidence = record.confidence;
    if (
      typeof confidence !== "string" ||
      !(DIRECTORY_OBSERVATION_CONFIDENCE as readonly string[]).includes(
        confidence,
      )
    ) {
      return fail(
        `observations[${index}].confidence ${JSON.stringify(
          confidence,
        )} is not low, medium or high`,
      );
    }

    const rawRefs = record.evidenceRefs;
    if (rawRefs !== undefined && !Array.isArray(rawRefs)) {
      return fail(`observations[${index}].evidenceRefs is not an array`);
    }
    const refs = (rawRefs ?? []) as unknown[];
    if (refs.length > DIRECTORY_OBSERVATION_LIMITS.maxEvidenceRefs) {
      return fail(
        `observations[${index}].evidenceRefs holds ${refs.length} entries, over the ${DIRECTORY_OBSERVATION_LIMITS.maxEvidenceRefs} cap`,
      );
    }
    const evidenceRefs: string[] = [];
    for (const [refIndex, ref] of refs.entries()) {
      const bounded = boundedString(
        ref,
        DIRECTORY_OBSERVATION_LIMITS.maxEvidenceRefChars,
      );
      if (!bounded.ok) {
        return fail(
          `observations[${index}].evidenceRefs[${refIndex}] ${bounded.why}`,
        );
      }
      evidenceRefs.push(bounded.value);
    }

    observations.push({
      id: id as Id,
      summary: summary.value,
      confidence: confidence as DirectoryObservationConfidence,
      evidenceRefs,
    });
  }

  return {
    ok: true,
    envelope: {
      readinessKind: schema.readinessKind,
      observationKind: observationKind as Kind,
      observationSchemaVersion: schema.schemaVersion,
      promptVersion: promptVersion.value,
      modelId: modelId.value,
      observedAt,
      observations,
    },
  };
}

/**
 * What one catalogued observation ID becomes when the model reports it.
 *
 * The lane, class, title and citation are the SDK's, fixed at build time. The
 * model contributes a summary, a confidence and some references — the parts
 * that cannot change what the finding MEANS.
 */
export interface DirectoryObservationMapping<
  Lane extends string,
  SourceRef,
  Id extends string,
> {
  id: Id;
  title: string;
  /** The publisher's experience lane. Never a dispositive one. */
  lane: Lane;
  class: DirectoryObservationFindingClass;
  source: SourceRef;
  /** One sentence the reader can act on, when the observation is worth acting on. */
  remediation?: string;
}

export interface DirectoryObservationCatalog<
  Lane extends string,
  SourceRef,
  Id extends string,
> {
  /**
   * The one lane every mapped finding may land in.
   *
   * Named separately from each mapping's `lane` so the guard below has
   * something to check the mappings AGAINST. A catalogue whose entries all
   * agree with each other is not evidence they agree with the publisher.
   */
  experienceLane: Lane;
  engineVersion: string;
  mappings: readonly DirectoryObservationMapping<Lane, SourceRef, Id>[];
}

/**
 * Turn a validated envelope into findings.
 *
 * THE GUARD IS NOT DECORATIVE. Both invariants below are re-checked here, at
 * the moment the finding is built, rather than trusted from the catalogue's
 * type: catalogues are data, data gets edited, and the edit that moves an
 * observation into `directory-policy` as `required` is one character wide and
 * would hand a model a vote on a submitter's verdict. A mapping that breaks
 * either invariant is DROPPED — not downgraded — because a catalogue in that
 * state is a bug to fix, and silently rewriting it would hide the bug behind a
 * plausible-looking finding.
 *
 * Observations with no mapping are dropped for a different and less alarming
 * reason: a backend running a newer catalogue than this SDK build will send
 * IDs this build has no rendering for, and dropping them degrades gracefully
 * where throwing would fail the whole run over an unknown line item. (An ID
 * outside the schema's `knownIds` never reaches here — the parse refused it.)
 */
export function mapObservationsToFindings<
  Lane extends string,
  SourceRef,
  Capability extends string,
  Id extends string,
>(
  envelope: DirectoryObservationEnvelope<string, Id> | undefined,
  catalog: DirectoryObservationCatalog<Lane, SourceRef, Id>,
  stamp: DirectoryCheckStamp,
): DirectoryReadinessFinding<Lane, SourceRef, Capability>[] {
  if (!envelope) return [];

  const constructors = createFindingConstructors<Lane, SourceRef, Capability>({
    engineVersion: catalog.engineVersion,
  });
  const byId = new Map(catalog.mappings.map((entry) => [entry.id, entry]));
  const allowedClasses = new Set<string>(DIRECTORY_OBSERVATION_FINDING_CLASSES);

  const findings: DirectoryReadinessFinding<Lane, SourceRef, Capability>[] = [];
  for (const observation of envelope.observations) {
    const mapping = byId.get(observation.id);
    if (!mapping) continue;
    if (mapping.lane !== catalog.experienceLane) continue;
    if (!allowedClasses.has(mapping.class)) continue;

    const definition: DirectoryCheckDefinition<Lane, SourceRef, Capability> = {
      id: mapping.id,
      title: mapping.title,
      lane: mapping.lane,
      class: mapping.class,
      source: mapping.source,
      // The model read evidence; it did not gather any. `passive` is the
      // truthful intrusiveness for a pass that touched nothing.
      provenance: "llm",
      intrusiveness: "passive",
    };

    // `informational` rather than `violated`, always. A `violated` heuristic is
    // already excluded from every rollup, but it renders in red and reads as a
    // failure — and a submitter who fixes an imaginary failure has been misled
    // by this product just as surely as one who shipped a real one.
    findings.push(
      constructors.informational(
        definition,
        stamp,
        {
          confidence: observation.confidence,
          evidenceRefs: observation.evidenceRefs,
          modelId: envelope.modelId,
          promptVersion: envelope.promptVersion,
          observationSchemaVersion: envelope.observationSchemaVersion,
          observedAt: envelope.observedAt,
          summary: observation.summary,
        },
        mapping.remediation ?? observation.summary,
      ),
    );
  }

  return findings;
}

/**
 * The state a run reports when observations were never asked for.
 *
 * A constant rather than an inline literal at each call site, because the
 * default is the one value every free run publishes and a call site that spelt
 * it `{ status: "not-requested" }` with no reason would make the reason field
 * look optional in exactly the case a reader most wants it.
 *
 * PARAMETERISED `<never, never>` so it satisfies every publisher's narrowed
 * state without a cast. Both parameters appear only inside `envelope`, which
 * this value does not carry, and `never` is assignable to any id union — so
 * the one constant fits a Claude result and an OpenAI one alike. Typed
 * `<string, string>` it would fit neither, and each publisher would need its
 * own copy of a sentence that says the same thing.
 */
export const NOT_REQUESTED_OBSERVATIONS: DirectoryObservationState<
  never,
  never
> = Object.freeze({
  status: "not-requested",
  reason: "not_requested",
  detail:
    "this run did not request model-backed observations, so nothing was charged",
});

/**
 * Build the state for a failure, with the reason a surface branches on.
 *
 * Centralised so `billing-blocked` always arrives carrying
 * `billing_limit_reached` — the pairing three surfaces key on, and one a call
 * site could otherwise get half right.
 */
export function observationFailure(
  status: Exclude<
    DirectoryObservationStatus,
    "completed" | "not-requested" | "pending"
  >,
  detail: string,
): DirectoryObservationState {
  const reason: DirectoryObservationReason =
    status === "billing-blocked"
      ? "billing_limit_reached"
      : status === "invalid-output"
      ? "schema_invalid"
      : "provider_error";
  return { status, reason, detail };
}
