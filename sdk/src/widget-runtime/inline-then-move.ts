/**
 * Claude's display-mode start rule
 * (claude.com/docs/connectors/building/mcp-apps/display-modes): an App starts
 * in the conversation and, once it has started and its tool call returned
 * without an error, moves once to the side panel when its resource prefers
 * `fullscreen`. An App that can only be full screen sits in the side panel
 * with a card in the conversation. A preference never opens an App over the
 * whole window.
 */

export type InlineThenMoveMode = "inline" | "fullscreen";

const PANEL_MODES: readonly InlineThenMoveMode[] = ["inline", "fullscreen"];

/**
 * The modes an App may use. Without a declaration, every mode the host
 * offers. A declaration with neither `inline` nor `fullscreen` (`[]`,
 * `["pip"]`) keeps the App in the conversation, as Claude does, instead of
 * refusing it. Otherwise, the modes both allow.
 */
export function inlineThenMoveModes(
  hostModes: readonly string[],
  appModes?: readonly string[]
): InlineThenMoveMode[] {
  const offered = PANEL_MODES.filter((mode) => hostModes.includes(mode));
  if (appModes === undefined) return offered;
  if (!PANEL_MODES.some((mode) => appModes.includes(mode))) return ["inline"];
  return offered.filter((mode) => appModes.includes(mode));
}

/** Full screen only for an App that can't be inline. */
export function inlineThenMoveStart(
  modes: readonly string[]
): InlineThenMoveMode {
  return modes.includes("fullscreen") && !modes.includes("inline")
    ? "fullscreen"
    : "inline";
}

/**
 * Whether to make the one move to the side panel: the App can be both inline
 * and full screen, prefers full screen, its tool result isn't an error, and
 * the host has a side panel to move it into. The caller moves at most once.
 */
export function shouldMoveToPanel(args: {
  modes: readonly string[];
  preferred: string | undefined;
  toolResultOk: boolean;
  panelAvailable: boolean;
}): boolean {
  return (
    args.modes.includes("inline") &&
    args.modes.includes("fullscreen") &&
    args.preferred === "fullscreen" &&
    args.toolResultOk &&
    args.panelAvailable
  );
}
