import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  inlineThenMoveStart,
  shouldMoveToPanel,
  type DisplayBehavior,
} from "@mcpjam/sdk/widget-runtime";

type Mode = "inline" | "fullscreen" | "pip";

const SETTLED_TOOL_STATES: ReadonlySet<string> = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

function isErrorResult(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "isError" in output &&
    output.isError === true
  );
}

/**
 * Claude's `inline-then-move` display rule for one chat App, on top of the
 * renderer's own clamp (see `inline-then-move.ts` in the SDK's widget
 * runtime). Inert under any other display behavior.
 *
 * - `startMode(negotiated)`: the mode an initialized App moves to when it
 *   can't stay where it started. A full-screen-only App goes to full screen
 *   only where a side panel can hold it; elsewhere it stays the renderer's
 *   card, which opens the whole-window fullscreen on a click.
 * - Once the App has started and its tool call has settled, it tries once to
 *   move an App that prefers full screen into the side panel. Claude tries
 *   only at that moment, so a panel that appears later doesn't move it.
 * - `panelCard`: a full-screen-only App in the side panel keeps a card in
 *   the conversation, and `showPanel` brings the panel back into view.
 */
export function useInlineThenMove(args: {
  behavior: DisplayBehavior | undefined;
  /** The App finished `ui/initialize`. */
  ready: boolean;
  toolState: string | undefined;
  toolOutput: unknown;
  /** The modes the App may use, after its own declaration. */
  modes: readonly Mode[];
  preferred: string | undefined;
  /** The host has a side panel this App can be placed in. */
  panelAvailable: boolean;
  fullscreen: boolean;
  /** The App is drawn in the side panel right now. */
  placed: boolean;
  /** The person sent the App back inline; a host move must not undo that. */
  preferInline: () => boolean;
  moveToPanel: () => void;
  revealPanel: (() => void) | undefined;
}) {
  const latest = useRef(args);
  useLayoutEffect(() => {
    latest.current = args;
  });
  const on = args.behavior?.start === "inline-then-move";
  const attempt =
    on && args.ready && SETTLED_TOOL_STATES.has(args.toolState ?? "");
  const tried = useRef(false);
  useEffect(() => {
    if (!attempt || tried.current) return;
    tried.current = true;
    const now = latest.current;
    const toolResultOk =
      now.toolState === "output-available" && !isErrorResult(now.toolOutput);
    if (
      !now.fullscreen &&
      !now.preferInline() &&
      shouldMoveToPanel({
        modes: now.modes,
        preferred: now.preferred,
        toolResultOk,
        panelAvailable: now.panelAvailable,
      })
    )
      now.moveToPanel();
  }, [attempt]);
  const startMode = useCallback(
    (negotiated: readonly Mode[]): Mode | undefined => {
      const now = latest.current;
      if (now.behavior?.start !== "inline-then-move") return undefined;
      const start = inlineThenMoveStart(negotiated);
      return start === "fullscreen" && !now.panelAvailable ? undefined : start;
    },
    [],
  );
  const showPanel = useCallback(() => latest.current.revealPanel?.(), []);
  return {
    startMode,
    panelCard: on && args.placed && !args.modes.includes("inline"),
    showPanel,
  };
}
