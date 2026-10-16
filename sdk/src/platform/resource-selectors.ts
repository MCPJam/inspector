import { PlatformApiError } from "./errors.js";

/**
 * Resolve a suite/scenario/server selector against a project listing the same
 * way `resolveProject` works: exact id first, then unique case-insensitive
 * name. Failures become NOT_FOUND platform errors whose message enumerates
 * the valid choices, so every surface renders the same actionable text.
 */
export function resolveByIdOrName<
  T extends { id: string; name?: string | null }
>(items: T[], selector: string, kind: string, scope: string): T {
  const trimmedSelector = selector.trim();
  const idMatch = items.find((item) => item.id === trimmedSelector);
  if (idMatch) {
    return idMatch;
  }

  const normalizedSelector = trimmedSelector.toLocaleLowerCase();
  const nameMatches = items.filter(
    (item) => item.name?.toLocaleLowerCase() === normalizedSelector
  );

  if (nameMatches.length === 1) {
    return nameMatches[0]!;
  }

  if (nameMatches.length > 1) {
    throw resolutionError(
      `${kind} name "${trimmedSelector}" is ambiguous in ${scope}. Use one of these IDs: ${formatResourceList(
        nameMatches
      )}.`
    );
  }

  throw resolutionError(
    items.length > 0
      ? `${kind} "${trimmedSelector}" was not found in ${scope}. Available: ${formatResourceList(
          items
        )}.`
      : `${kind} "${trimmedSelector}" was not found: ${scope} has none.`
  );
}

export function formatResourceList(
  items: Array<{ id: string; name?: string | null }>
): string {
  return items
    .map((item) => `${item.name ?? "(unnamed)"} (id: ${item.id})`)
    .join(", ");
}

export function resolutionError(message: string): PlatformApiError {
  return new PlatformApiError(message, "NOT_FOUND", { status: 0 });
}

/**
 * A caller-input problem the SDK can see without a round trip. Carries the same
 * `VALIDATION_ERROR` code the API would return, so surfaces render it
 * identically. Guards live in `execute` bodies, not `.refine()`, because the
 * CLI calls `execute` directly and never parses the input schema — a
 * refine-only guard would simply not fire there.
 */
export function operationInputError(message: string): PlatformApiError {
  return new PlatformApiError(message, "VALIDATION_ERROR", { status: 0 });
}
