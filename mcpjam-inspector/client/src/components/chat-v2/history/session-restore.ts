export function hasSameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((value, index) => value === right[index]);
}

export const DIRECT_GUEST_SERVER_SELECTION_SENTINEL = "__guest__";

export function resolveRestorableServerNames(
  savedServers: string[] | undefined,
  serversById: Map<string, string>,
  knownServerNames: Iterable<string>,
): string[] {
  if (!Array.isArray(savedServers) || savedServers.length === 0) {
    return [];
  }

  const knownNames = new Set(knownServerNames);
  const resolved: string[] = [];

  for (const savedServer of savedServers) {
    const resolvedName =
      serversById.get(savedServer) ??
      (knownNames.has(savedServer) ? savedServer : null);
    if (!resolvedName || resolved.includes(resolvedName)) {
      continue;
    }
    resolved.push(resolvedName);
  }

  return resolved;
}

export function shouldPreserveGuestServerSelection(
  savedServers: string[] | undefined,
  resolvedServerNames: string[],
  currentServerNames: string[],
): boolean {
  return (
    Array.isArray(savedServers) &&
    savedServers.includes(DIRECT_GUEST_SERVER_SELECTION_SENTINEL) &&
    resolvedServerNames.length === 0 &&
    currentServerNames.length > 0
  );
}
