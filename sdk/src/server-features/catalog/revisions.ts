/**
 * Core protocol revisions the catalog's lifecycles may name, oldest first.
 * Every `FeatureLifecycle` version is one of these wire literals, and the
 * catalog guard checks that every revision MCPJam can pin is listed here, so
 * adding a revision to the SDK without reviewing feature lifecycles fails CI.
 */

export const CORE_REVISIONS = [
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
] as const;

export type CoreRevision = (typeof CORE_REVISIONS)[number];

export function isCoreRevision(value: string): value is CoreRevision {
  return (CORE_REVISIONS as readonly string[]).includes(value);
}

/**
 * Orders two known revisions: negative when `a` is older, 0 when equal.
 * Unknown revisions sort after every known one, so a newer revision the
 * catalog has not reviewed never reads as older than a removal.
 */
export function compareCoreRevisions(a: string, b: string): number {
  const rank = (value: string) => {
    const index = (CORE_REVISIONS as readonly string[]).indexOf(value);
    return index === -1 ? CORE_REVISIONS.length : index;
  };
  return rank(a) - rank(b);
}
