export interface ClientDisplayNameSource {
  hostId: string;
  name: string;
  createdAt: number;
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function stableClientOrder(
  left: ClientDisplayNameSource,
  right: ClientDisplayNameSource,
): number {
  return (
    left.createdAt - right.createdAt || left.hostId.localeCompare(right.hostId)
  );
}

/**
 * Compute unique, presentation-only names without changing stored client names.
 * Preset labels own the unsuffixed name; intentional stored suffixes are
 * reserved before generated suffixes are allocated.
 */
export function resolveClientDisplayNames(
  clients: ReadonlyArray<ClientDisplayNameSource>,
  presetNames: ReadonlyArray<string>,
): ReadonlyMap<string, string> {
  const presetByKey = new Map<string, string>();
  for (const presetName of presetNames) {
    const trimmed = presetName.trim();
    if (trimmed) presetByKey.set(nameKey(trimmed), trimmed);
  }

  const groups = new Map<string, ClientDisplayNameSource[]>();
  const rawNameByKey = new Map<string, string>();
  for (const client of clients) {
    const trimmed = client.name.trim() || "Client";
    const key = nameKey(trimmed);
    rawNameByKey.set(key, rawNameByKey.get(key) ?? trimmed);
    const group = groups.get(key) ?? [];
    group.push(client);
    groups.set(key, group);
  }

  // Literal preset and stored names win over generated aliases. For example,
  // an intentional "Cursor #2" makes the generated Cursor copy start at #3.
  const used = new Set<string>([...presetByKey.keys(), ...rawNameByKey.keys()]);
  const displayNames = new Map<string, string>();

  for (const [key, group] of groups) {
    const ordered = [...group].sort(stableClientOrder);
    const presetName = presetByKey.get(key);
    const baseName = (presetName ?? ordered[0]?.name.trim()) || "Client";
    let nextSuffix = 2;

    ordered.forEach((client, index) => {
      if (!presetName && index === 0) {
        displayNames.set(client.hostId, baseName);
        return;
      }

      let candidate = `${baseName} #${nextSuffix}`;
      while (used.has(nameKey(candidate))) {
        nextSuffix += 1;
        candidate = `${baseName} #${nextSuffix}`;
      }
      used.add(nameKey(candidate));
      displayNames.set(client.hostId, candidate);
      nextSuffix += 1;
    });
  }

  return displayNames;
}

export function clientDisplayName(client: {
  name: string;
  displayName?: string;
}): string {
  return client.displayName ?? client.name;
}
