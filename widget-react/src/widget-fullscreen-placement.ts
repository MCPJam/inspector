import { createContext } from "react";

/**
 * Where a chat App draws itself when it goes fullscreen. Without a placement
 * it covers the window (today's chat fullscreen). With one, the host gives a
 * viewport rectangle instead — the Playground's right-rail App area for
 * clients whose Apps move into a side panel tab — and the App's DOM parent
 * never changes, so it doesn't reload. A placed App stacks above the panel
 * that holds its rectangle, even when that panel is itself layered over the
 * chat (a narrow window's side panel).
 */
export interface WidgetFullscreenPlacement {
  rect: { top: number; left: number; width: number; height: number } | null;
  /** Text for the exit control (e.g. "Exit full screen"); an X when absent. */
  exitLabel?: string;
  /** The placed App announces itself: its label and how to leave fullscreen. */
  onEnter?: (app: { label: string; exit: () => void }) => void;
  onLeave?: () => void;
  /**
   * The person left fullscreen with the placed App's own exit control, as
   * opposed to the host ending it (another tab chosen, the panel hidden).
   */
  onExit?: () => void;
}

export const WidgetFullscreenPlacementContext =
  createContext<WidgetFullscreenPlacement | null>(null);
