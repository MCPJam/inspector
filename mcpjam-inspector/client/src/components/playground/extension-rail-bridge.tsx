import { useEffect, useRef } from "react";
import {
  useExtensionStore,
  useExtensionWorkspaceState,
} from "@/components/host-workspace/ExtensionWorkspaceProvider";
import { useExtensionRail } from "@/components/host-workspace/use-extension-rail";
import { focusChatComposer } from "@/components/chat-v2/chat-input/composer-focus";

const RIGHT_RAIL_SIZE_KEY = "mcpjam.playground.rightRailSize";
const DEFAULT_RIGHT_RAIL_SIZE = 30;
/** Narrower than this is a sliver left by a drag, not a width to come back to. */
export const MIN_USABLE_RIGHT_RAIL_SIZE = 15;

/** The rail's remembered width (percent of the panel group). */
export function readRightRailSize(): number {
  try {
    const value = Number(window.localStorage.getItem(RIGHT_RAIL_SIZE_KEY));
    return Number.isFinite(value) &&
      value >= MIN_USABLE_RIGHT_RAIL_SIZE &&
      value <= 50
      ? value
      : DEFAULT_RIGHT_RAIL_SIZE;
  } catch {
    return DEFAULT_RIGHT_RAIL_SIZE;
  }
}

/** The part of a resizable panel the rail reveal needs. */
export interface RevealablePanel {
  isCollapsed?: () => boolean;
  getSize?: () => number;
  resize: (size: number) => void;
}

/**
 * Bring the rail to a usable width. A panel that is open but dragged down to
 * a sliver counts as closed: revealing an App (or its settings) into a few
 * pixels looks like nothing happened.
 */
export function revealRightRailPanel(
  panel: RevealablePanel | null | undefined,
  rememberedSize: number,
) {
  if (!panel) return;
  if (
    panel.isCollapsed?.() ||
    (panel.getSize?.() ?? 0) < MIN_USABLE_RIGHT_RAIL_SIZE
  )
    panel.resize(Math.max(rememberedSize, MIN_USABLE_RIGHT_RAIL_SIZE));
}

export function writeRightRailSize(size: number) {
  try {
    if (size >= MIN_USABLE_RIGHT_RAIL_SIZE && size <= 50)
      window.localStorage.setItem(RIGHT_RAIL_SIZE_KEY, String(size));
  } catch {
    // Remembering the width is a convenience.
  }
}

/**
 * Connects plugin extensions to the Playground layout: opening an App (or its
 * settings) reveals the right rail, and the layout learns whether an App tab
 * is selected (a narrow window then expands the rail over the chat).
 *
 * It also keeps a model App's fullscreen recoverable at every width:
 * - Hiding the rail ends the fullscreen it holds; the App returns to its
 *   message instead of falling back to covering the window.
 * - Leaving fullscreen from the App or its tab collapses a narrow window's
 *   rail, so the chat and its composer come back.
 * - While the rail covers the chat, Escape collapses it, and once it stops
 *   covering the chat, focus goes back to the composer.
 */
export function ExtensionRailBridge({
  onReveal,
  onAppActiveChange,
  visible,
  narrow,
  overlay,
  onCollapse,
  composerRoot,
}: {
  onReveal: () => void;
  onAppActiveChange: (active: boolean) => void;
  /** The rail is open (not collapsed to zero width). */
  visible: boolean;
  /** The layout is too narrow for the rail beside the chat. */
  narrow: boolean;
  /** The rail is laid over the chat. */
  overlay: boolean;
  /** Collapses the rail. */
  onCollapse: () => void;
  /** Where the chat composer lives, for handing focus back to it. */
  composerRoot: ParentNode | null;
}) {
  const store = useExtensionStore();
  const revealSeq =
    useExtensionWorkspaceState((state) => state.railRevealSeq) ?? 0;
  const dismissSeq =
    useExtensionWorkspaceState((state) => state.railDismissSeq) ?? 0;
  const rail = useExtensionRail();
  const appActive = rail.enabled && rail.activeId !== null;
  const seen = useRef(revealSeq);
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  const collapse = useRef(onCollapse);
  collapse.current = onCollapse;
  const latest = useRef({ narrow, visible, composerRoot });
  latest.current = { narrow, visible, composerRoot };
  useEffect(() => {
    if (seen.current === revealSeq) return;
    seen.current = revealSeq;
    reveal.current();
  }, [revealSeq]);
  useEffect(() => {
    onAppActiveChange(appActive);
  }, [appActive, onAppActiveChange]);

  // A fullscreen App is drawn over the rail; with the rail gone it would
  // cover the window, chat and composer included. Collapsing ends it.
  const wasVisible = useRef(visible);
  useEffect(() => {
    const hidden = wasVisible.current && !visible;
    wasVisible.current = visible;
    if (hidden) store?.getState().modelFullscreen?.exit();
  }, [visible, store]);

  const seenDismiss = useRef(dismissSeq);
  useEffect(() => {
    if (seenDismiss.current === dismissSeq) return;
    seenDismiss.current = dismissSeq;
    if (latest.current.narrow && latest.current.visible) collapse.current();
  }, [dismissSeq]);

  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // A menu or dialog closing on the same Escape marks it handled.
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      event.preventDefault();
      collapse.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [overlay]);

  // The overlay closed in a narrow window. Focus that was in the collapsed
  // rail, or went with a removed control, returns to the composer; focus
  // the person moved inside a still-open rail (choosing Logs) stays.
  const wasOverlay = useRef(overlay);
  useEffect(() => {
    const closed = wasOverlay.current && !overlay;
    wasOverlay.current = overlay;
    if (!closed || !latest.current.narrow) return;
    const active = document.activeElement;
    const focusLost =
      !active || active === document.body || !active.isConnected;
    if (latest.current.visible && !focusLost) return;
    focusChatComposer(latest.current.composerRoot);
  }, [overlay]);
  return null;
}
