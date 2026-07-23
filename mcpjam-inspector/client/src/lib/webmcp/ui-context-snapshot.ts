/**
 * Builds the per-turn UI orientation payload attached to each agent message.
 *
 * Read at send time, never memoized: the user may have navigated between
 * turns, and stale orientation is worse than none — it would tell the model
 * with confidence that the user is somewhere they left.
 *
 * Deliberately small. This is orientation ("you're on Connect, two servers
 * selected"), not a state dump; the model pulls detail on demand with
 * `ui_snapshot_app`. Every byte here is paid on every turn.
 */
import {
  UI_CONTEXT_PART_TYPE,
  type UiContextDataPart,
  type UiContextPayload,
} from "@/shared/ui-context";
import { pathnameToActiveTab } from "@/lib/app-navigation";
import { getSelectedServerNames } from "./ui-context-source";

export interface UiContextSources {
  /** Server NAMES currently selected. Names, not ids: the model speaks names. */
  selectedServers?: string[];
  /** Injectable for tests; defaults to the live location. */
  pathname?: string;
  /** Injectable for tests; defaults to now. */
  now?: () => number;
}

export function buildUiContextPayload(
  sources: UiContextSources = {},
): UiContextPayload {
  const pathname =
    sources.pathname ??
    (typeof window !== "undefined" ? window.location.pathname : "/");
  const timestamp = new Date(sources.now?.() ?? Date.now()).toISOString();
  // Default to the published selection when the caller didn't pass one — the
  // agent hook can't reach app state, so App.tsx publishes it (see
  // ui-context-source). Empty is fine and meaningful ("nothing selected").
  const selectedServers = sources.selectedServers ?? getSelectedServerNames();
  return {
    path: pathname,
    activeTab: pathnameToActiveTab(pathname),
    selectedServers,
    timestamp,
  };
}

export function buildUiContextPart(
  sources: UiContextSources = {},
): UiContextDataPart {
  return { type: UI_CONTEXT_PART_TYPE, data: buildUiContextPayload(sources) };
}
