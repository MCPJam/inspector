import { useBrowserEngine } from "./useBrowserEngine";
import { useBrowserToolIds } from "./useBrowserToolIds";
import type { ComparePane } from "@/lib/compare-panes";
import type { PlaygroundClientColumn } from "@/lib/playground-client-columns";

type Column = Pick<
  PlaygroundClientColumn,
  "compareId" | "hostId" | "hostConfig"
>;

function usePaneBrowser(
  column: Column | undefined,
  panes: readonly ComparePane[],
  projectId: string | null,
  preference: ReturnType<typeof useBrowserEngine>,
) {
  const target = panes.find(
    (pane) => pane.paneId === column?.compareId,
  )?.target;
  const engine = target?.kind === "environment" ? "cloud" : preference.engine;
  const ids = useBrowserToolIds(column?.hostConfig, engine, {
    projectId: column ? projectId : null,
    hostId: column?.hostId ?? null,
  });
  return {
    builtInToolIds: ids,
    personalBrowserEngine: {
      engine,
      consentToken:
        engine === "local" && preference.localAvailable
          ? preference.consent.token
          : null,
    },
  };
}

/** Named setups run in the cloud. A sibling comparing the same client keeps
 * the device preference, even after entering Compare from a named setup. */
export function usePlaygroundBrowserToolSlots(
  columns: readonly Column[],
  panes: readonly ComparePane[],
  projectId: string | null,
) {
  const preference = useBrowserEngine(
    columns.length ? projectId : null,
    "preference",
  );
  // The grid has three fixed slots; every slot calls the same hooks on every render.
  const first = usePaneBrowser(columns[0], panes, projectId, preference);
  const second = usePaneBrowser(columns[1], panes, projectId, preference);
  const third = usePaneBrowser(columns[2], panes, projectId, preference);
  return new Map(
    columns.map((column, i) => [column.compareId, [first, second, third][i]]),
  );
}
