import { useBrowserToolIds } from "@/hooks/useBrowserToolIds";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";

/**
 * Resolve each compare column's built-in tool ids — browser attachment
 * included — through the SAME hook the single-pane chat and the Tools rail
 * use, in a rules-of-hooks-safe way.
 *
 * WHY THIS EXISTS. The grid used to resolve its columns with an inline copy
 * of the hook's logic, because a hook cannot be called from inside a `.map()`.
 * The copy drifted, as copies do: it never read the member's saved
 * `hosts:getLocalBrowserSettings`, so a per-host Browser setting applied to
 * the single pane and silently did nothing to a column of the same host; and
 * it had no "the setting is still loading" guard, so a column could commit to
 * no-browser on its first render and keep that answer for the turn. A guest
 * who had allowed Browser got three columns that told them they cannot browse.
 *
 * Same shape and same reasoning as `usePlaygroundHostSlots`: the compare grid
 * caps at 3 columns, so make 3 unconditional calls and let the hook
 * short-circuit on a missing config. Callers slice to the live column count.
 * Raising the cap means editing this file, that one, and the grid-column
 * helper — which is the point of keeping the cap in named places rather than
 * in a `.map()` nobody can extend safely.
 */
export function usePlaygroundBrowserToolSlots(
  columns: {
    hostId: string;
    config: HostConfigDtoV2;
  }[],
  engine: "local" | "cloud",
  projectId: string | null,
): [string[] | undefined, string[] | undefined, string[] | undefined] {
  // An empty slot passes a null project so the settings query is skipped
  // rather than subscribing on behalf of a column that does not exist.
  const slot0 = useBrowserToolIds(columns[0]?.config, engine, {
    projectId: columns[0] ? projectId : null,
    hostId: columns[0]?.hostId ?? null,
  });
  const slot1 = useBrowserToolIds(columns[1]?.config, engine, {
    projectId: columns[1] ? projectId : null,
    hostId: columns[1]?.hostId ?? null,
  });
  const slot2 = useBrowserToolIds(columns[2]?.config, engine, {
    projectId: columns[2] ? projectId : null,
    hostId: columns[2]?.hostId ?? null,
  });
  return [slot0, slot1, slot2];
}
