export interface ChangedToken {
  name: string;
  from: string;
  to: string;
}

export interface StyleVariableDiff {
  added: Array<{ name: string; value: string }>;
  removed: Array<{ name: string; value: string }>;
  changed: ChangedToken[];
}

export function diffStyleVariables(
  from: Record<string, string>,
  to: Record<string, string>,
): StyleVariableDiff {
  const added: StyleVariableDiff["added"] = [];
  const removed: StyleVariableDiff["removed"] = [];
  const changed: ChangedToken[] = [];

  for (const [name, value] of Object.entries(to)) {
    if (!(name in from)) {
      added.push({ name, value });
    } else if (from[name] !== value) {
      changed.push({ name, from: from[name], to: value });
    }
  }
  for (const [name, value] of Object.entries(from)) {
    if (!(name in to)) {
      removed.push({ name, value });
    }
  }

  added.sort((a, b) => a.name.localeCompare(b.name));
  removed.sort((a, b) => a.name.localeCompare(b.name));
  changed.sort((a, b) => a.name.localeCompare(b.name));
  return { added, removed, changed };
}

export function diffChangeCount(diff: StyleVariableDiff): number {
  return diff.added.length + diff.removed.length + diff.changed.length;
}

export function summarizeTokenDiff(diff: StyleVariableDiff): {
  colors: number;
  radius: number;
  other: number;
} {
  const names = [
    ...diff.added.map((t) => t.name),
    ...diff.removed.map((t) => t.name),
    ...diff.changed.map((t) => t.name),
  ];
  let colors = 0;
  let radius = 0;
  let other = 0;
  for (const name of names) {
    if (name.startsWith("--color-")) colors += 1;
    else if (name.startsWith("--border-radius-")) radius += 1;
    else other += 1;
  }
  return { colors, radius, other };
}
