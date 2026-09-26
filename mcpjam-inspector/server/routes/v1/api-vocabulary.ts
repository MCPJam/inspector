/**
 * `x-mcpjam-api-vocabulary` — the negotiation header for the public API's
 * resource-noun VALUES.
 *
 * Three nouns were renamed at the API boundary: `scenario` → **study**,
 * `journey` → **goal**, `wave` → **swarm run**. Operation names, routes, type
 * names and field names could all move behind a deprecated alias, because a
 * caller reaches them by a name it chose. A VALUE cannot: `sourceType` is one
 * field with one string in it, and a client switching on `"scenario"` has no
 * second name to fall back to. So the value families negotiate instead.
 *
 * Absent means vocabulary 1, byte-for-byte today's contract. `2` is the
 * canonical one. Any other value is a 400 — a vocabulary mismatch has to be
 * loud. The parse, the `Vary` and the refusal are shared with the eval header
 * (`./vocabulary-header.ts`): what the two negotiate differs entirely, how
 * they negotiate must not.
 *
 * FOUR VALUE FAMILIES, and the fifth thing that is NOT one:
 *   1. `sourceType` / `sourceTypes` on sessions and trace destinations.
 *   2. `resourceType` on shares — a PATH SEGMENT as well as a response field.
 *   3. `parentRef.kind` and its noun-bearing id fields (Convex's, projected
 *      in `mcpjam-backend`; this module only widens what the proxy accepts).
 *   4. Permalink resource types (`user_testing_scenario`, `journey_run`),
 *      which are table KEYS in `@mcpjam/sdk/platform` rather than a
 *      per-request projection — see `permalinks.ts`.
 * Not a family: `SWARM_FINDING_SCOPE_LEVELS`'s `"wave"`. That is a versioned,
 * backend-mirrored CONTRACT value; renaming it is a contract version bump, not
 * a projection.
 *
 * STORAGE DOES NOT MOVE. The stored literals are still `scenario`; this is a
 * projection applied on the way out and an acceptance widening on the way in.
 */

import type { Context } from "hono";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import {
  hasUnknownVocabularyValue,
  parseVocabularyValue,
  unknownVocabularyMessage,
  vocabularyForHeader,
  type Vocabulary,
} from "./vocabulary-header.js";

export const API_VOCABULARY_HEADER = "x-mcpjam-api-vocabulary";

/** The vocabularies this deployment speaks. */
export type ApiVocabulary = Vocabulary;

/** Parse the header. `null` means present-and-unrecognised — a 400. */
export function parseApiVocabulary(
  raw: string | undefined,
): ApiVocabulary | null {
  return parseVocabularyValue(raw);
}

/** The vocabulary this request negotiated, and the `Vary` that goes with it. */
export function apiVocabularyOf(c: Context): ApiVocabulary {
  return vocabularyForHeader(c, API_VOCABULARY_HEADER);
}

/** True when the request named a vocabulary this deployment does not speak. */
export function hasUnknownApiVocabulary(c: Context): boolean {
  return hasUnknownVocabularyValue(c, API_VOCABULARY_HEADER);
}

/** The message a refused header gets, naming both valid values. */
export const UNKNOWN_API_VOCABULARY_MESSAGE = unknownVocabularyMessage(
  API_VOCABULARY_HEADER,
);

/**
 * Refuse an unrecognised header, then read the negotiated vocabulary.
 *
 * One call rather than two because every handler wants both in that order,
 * and a handler that read the vocabulary without refusing first would serve a
 * caller who asked for a vocabulary this deployment does not speak — silently,
 * in the legacy spelling, which is the outcome the negotiation exists to
 * prevent. Reading also appends `Vary`.
 */
export function negotiatedVocabulary(c: Context): ApiVocabulary {
  if (hasUnknownApiVocabulary(c)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      UNKNOWN_API_VOCABULARY_MESSAGE,
    );
  }
  return apiVocabularyOf(c);
}

// ── the value families ───────────────────────────────────────────────────────

/**
 * `scenario` → `study`, the one entry in every family below.
 *
 * `swarm` is deliberately absent: it is the PRODUCT name and always was, so
 * `wave` → swarm run does not touch it. `direct`, `eval` and `chatbox` were
 * never renamed.
 */
const STUDY_V2 = "study";
const STUDY_V1 = "scenario";

/** The canonical spelling of one stored value, for the negotiated vocabulary. */
export function projectNounValue(
  stored: string,
  vocabulary: ApiVocabulary,
): string {
  if (vocabulary === 1) return stored;
  return stored === STUDY_V1 ? STUDY_V2 : stored;
}

/**
 * One REQUESTED value back into the spelling the query and the storage use.
 *
 * A vocabulary-2 caller may send either: `study` because that is what the
 * responses say, and `scenario` because a half-migrated caller is better
 * served than refused. A vocabulary-1 caller may send only `scenario` —
 * widening vocabulary 1 to meet vocabulary 2 half way is exactly what makes a
 * negotiation boundary undecidable.
 */
export function storageNounValue(
  requested: string,
  vocabulary: ApiVocabulary,
): string {
  if (vocabulary === 1) return requested;
  return requested === STUDY_V2 ? STUDY_V1 : requested;
}

/** Every value a request may name under this vocabulary. */
export function acceptedNounValues(
  storedValues: readonly string[],
  vocabulary: ApiVocabulary,
): string[] {
  if (vocabulary === 1) return [...storedValues];
  const accepted = new Set<string>(storedValues);
  if (accepted.has(STUDY_V1)) accepted.add(STUDY_V2);
  return [...accepted];
}

/**
 * What this deployment understands, advertised on the project capabilities
 * read so a client reads the value rather than inferring support from the
 * presence of a field on an unrelated object.
 *
 * `resourceTypes` is the permalink table, listed separately because those are
 * table KEYS rather than a per-request projection: both spellings resolve at
 * all times, and which one a response carries follows the OPERATION (a
 * renamed operation derives the canonical key, its deprecated twin the old
 * one) rather than this header.
 */
export const API_VOCABULARY_CAPABILITY = {
  version: 2,
  values: {
    sourceType: { scenario: STUDY_V2 },
    resourceType: { scenario: STUDY_V2 },
    parentRefKind: { scenario: STUDY_V2, journeyRun: "goalRun" },
  },
  resourceTypes: {
    study: ["user_testing_scenario"],
    goal_run: ["journey_run"],
  },
} as const;
