/**
 * The five requirement statuses, and the only place they are spelled.
 *
 * The coverage contract lives in Kestral, so no build can fail when the prose
 * and this code disagree about the vocabulary. This file is the compensating
 * control: the scanner imports these names instead of repeating string
 * literals, and the test below pins the set, so anything quoting the contract
 * elsewhere can be checked against one exported list rather than a sentence
 * someone retyped.
 *
 * SOURCE_ASSIGNABLE is the narrower point. A static scan can only ever reach
 * the first three. VERIFIED needs evidence from a deployed release, and EXEMPT
 * needs a named reviewer, so neither can be inferred from reading code. Anything
 * that marks a row verified from source alone is wrong by construction.
 */
export const STATUS = Object.freeze({
  /** Discovery, applicability or evidence has not been resolved. */
  UNKNOWN: 'unknown',
  /** A required producer, property, behavior, query or detector is missing or fails. */
  GAP: 'gap',
  /** A producer or adapter exists; one or more proof gates remain. */
  INSTRUMENTED_UNVERIFIED: 'instrumented-unverified',
  /** All applicable gates passed against the deployed release and configuration. */
  VERIFIED: 'verified',
  /** A reviewed reason, reviewer, owner and review condition. Counted separately. */
  EXEMPT: 'exempt',
});

/** Every legal status. */
export const ALL_STATUSES = Object.freeze([
  STATUS.UNKNOWN,
  STATUS.GAP,
  STATUS.INSTRUMENTED_UNVERIFIED,
  STATUS.VERIFIED,
  STATUS.EXEMPT,
]);

/** What a static scan may assign. The other two require evidence a scan cannot have. */
export const SOURCE_ASSIGNABLE = Object.freeze([
  STATUS.UNKNOWN,
  STATUS.GAP,
  STATUS.INSTRUMENTED_UNVERIFIED,
]);

export function isStatus(value) {
  return ALL_STATUSES.includes(value);
}
