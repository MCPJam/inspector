/**
 * Fixture references inside call arguments.
 *
 * `{ "$fixture": "project", "value": "id" }` anywhere in a call's arguments
 * stands for that fixture's value, and the whole object is replaced by it
 * before the call: an existing fixture's value from the plan, a created
 * fixture's from the call that created it.
 *
 * Pure. Safe from the browser entry.
 */

export interface DirectoryFixtureReference {
  fixture: string;
  /** Empty when the reference names no value, which the validator refuses. */
  value: string;
}

/** Every fixture reference in a value, in the order they appear. */
export function directoryFixtureReferences(
  value: unknown
): DirectoryFixtureReference[] {
  const found: DirectoryFixtureReference[] = [];
  replaceReferences(value, (reference) => {
    found.push(reference);
    return undefined;
  });
  return found;
}

/**
 * The arguments with every reference replaced, or the `fixture.value` names
 * nothing could fill: a call is never sent with a placeholder in it.
 */
export function resolveDirectoryTestArguments(
  args: Record<string, unknown>,
  values: Readonly<Record<string, Readonly<Record<string, string | number>>>>
): { arguments: Record<string, unknown> } | { missing: string[] } {
  const missing: string[] = [];
  const resolved = replaceReferences(args, ({ fixture, value }) => {
    const filled = own(own(values, fixture), value);
    if (filled === undefined) missing.push(`${fixture}.${value}`);
    return filled;
  });
  return missing.length > 0
    ? { missing }
    : { arguments: resolved as Record<string, unknown> };
}

/** Own keys only: a fixture named `constructor` must not find Object's. */
function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string
): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function referenceIn(value: unknown): DirectoryFixtureReference | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { $fixture: fixture, value: name } = value as Record<string, unknown>;
  if (typeof fixture !== "string") return undefined;
  return { fixture, value: typeof name === "string" ? name : "" };
}

function replaceReferences(
  value: unknown,
  replace: (reference: DirectoryFixtureReference) => unknown
): unknown {
  const reference = referenceIn(value);
  if (reference) return replace(reference);
  if (Array.isArray(value)) {
    return value.map((entry) => replaceReferences(entry, replace));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceReferences(entry, replace),
      ])
    );
  }
  return value;
}
