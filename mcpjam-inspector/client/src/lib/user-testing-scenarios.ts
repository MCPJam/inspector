import type { ScenarioListItem } from "@/hooks/useScenarios";

/**
 * Is this scenario row a SCENARIO someone deliberately made, rather than the
 * publish surface every client is born with?
 *
 * `scenarios` rows are minted 1:1 with hosts by `hosts.createHost`, so a
 * project accumulates one per client whether or not anyone intended to test
 * with it — including the three the Playground seeds into an empty project and
 * the "MCPJam" one the host bar seeds. Listing them all made a brand-new
 * project show four or five "scenarios" nobody created.
 *
 * There is no `publishedAt` bit on the row to read, so intent is inferred from
 * signals that only a deliberate act produces:
 *
 *  - `environmentId` — the row exists ONLY because someone published an
 *    environment. This is the canonical scenario going forward;
 *  - a non-default access mode — every auto-mint path uses the backend default
 *    (`project_members`), so `invited_only` / `anyone_with_link` means a human
 *    chose who could open it;
 *  - real tester history — someone opened the share link, whatever the row's
 *    origin. Positive counters are reliable (they are written at session
 *    insert); zero is ambiguous for rows that predate them, which is why zero
 *    is not treated as evidence of anything.
 *
 * The known miss: a legacy host-backed scenario left at the default mode whose
 * sessions all predate the counters. It stays reachable by its link and by the
 * public API — the alternative is showing every client forever.
 */
export function isDeliberateScenario(row: ScenarioListItem): boolean {
  if (row.environmentId) return true;
  if (row.mode !== "project_members") return true;
  return (
    (row.sessionCount ?? 0) > 0 ||
    (row.uniqueTesterCount ?? 0) > 0 ||
    row.lastSessionAt != null
  );
}
