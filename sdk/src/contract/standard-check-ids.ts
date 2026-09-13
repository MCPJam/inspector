/**
 * Stable authoring families. Kept separate from content-derived scorer ids.
 * Mirrored in the backend (`convex/lib/mirrors.json` id `standard-check-ids`);
 * changes require catalog/validator parity tests.
 *
 * FROZEN once shipped: these keys are persisted on
 * `testCase.suppressedSuiteStandardCheckIds` and hashed into the backend's
 * `configRevision` and every revision snapshot, both of which normalize and
 * THROW on an unknown id. Removing or renaming a key breaks every stored case
 * that suppressed it. Treat this map like the scorer id template: add, never
 * remove.
 */
export const STANDARD_CHECK_ASSERTION_KINDS = {
  "discovery.description": "toolDescriptionsPresent",
  "discovery.annotations": "toolAnnotationsPresent",
  "discovery.collisions": "toolNamesUnique",
  "discovery.deprecated": "noDeprecatedToolExposed",
  "call.schema": "toolInputSchemasWellFormed",
  "response.schema": "toolOutputSchemasPresent",
  "selection.hops": "toolCallCountUnder",
  "call.parameters": "argumentsMatchToolSchema",
  "call.repeated": "noRepeatedIdenticalCall",
  "response.performance": "toolLatencyUnder",
  "response.size": "toolResultSizeUnder",
  "response.errors": "noToolErrors",
  "response.recovery": "toolErrorNamesInput",
  "response.pagination": "fullPageHasContinuation",
  "userValue.turns": "turnCountUnder",
} as const;

export type StandardAssertionCheckId =
  keyof typeof STANDARD_CHECK_ASSERTION_KINDS;

export function isStandardAssertionCheckId(
  id: string
): id is StandardAssertionCheckId {
  return Object.prototype.hasOwnProperty.call(
    STANDARD_CHECK_ASSERTION_KINDS,
    id
  );
}

/** Empty/absent remain absent, preserving existing configuration fingerprints. */
export function normalizeSuppressedStandardCheckIds(
  ids: readonly string[] | undefined
): StandardAssertionCheckId[] | undefined {
  if (!ids?.length) return undefined;
  if (ids.length > 64 || ids.some((id) => !isStandardAssertionCheckId(id))) {
    throw new Error(
      "Suppression must contain at most 64 known standard assertion check ids"
    );
  }
  return [...new Set(ids)].sort() as StandardAssertionCheckId[];
}

export function filterSuppressedSuiteAssertions<T extends { type: string }>(
  defaults: readonly T[],
  ids: readonly string[] | undefined
): T[] {
  const suppressed = new Set(
    (normalizeSuppressedStandardCheckIds(ids) ?? []).map(
      (id) => STANDARD_CHECK_ASSERTION_KINDS[id] as string
    )
  );
  return defaults.filter((rule) => !suppressed.has(rule.type));
}
