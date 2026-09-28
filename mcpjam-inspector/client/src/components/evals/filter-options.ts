/** Options for one facet, constrained by every other facet. Keep selections clearable. */
export function dependentFilterOptions<T>(
  rows: readonly T[],
  facets: Record<
    string,
    { selected: readonly string[]; values: (row: T) => readonly string[] }
  >,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(facets).map(([key, facet]) => [
      key,
      [
        ...new Set([
          ...facet.selected,
          ...rows
            .filter((row) =>
              Object.entries(facets).every(
                ([otherKey, other]) =>
                  otherKey === key ||
                  other.selected.length === 0 ||
                  other
                    .values(row)
                    .some((value) => other.selected.includes(value)),
              ),
            )
            .flatMap((row) => [...facet.values(row)]),
        ]),
      ].sort(),
    ]),
  );
}

export function selectedFilter(value: string): string[] {
  return value === "__all__" ? [] : [value];
}
