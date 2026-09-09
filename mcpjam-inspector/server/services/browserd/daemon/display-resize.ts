/**
 * Changing the size of a hosted box's X display, without restarting anything.
 *
 * The hosted engine is the one where "the display IS the page" is literally
 * true: Chromium runs in kiosk mode filling the X screen, the video encoder
 * grabs that screen with `x11grab`, and the page's CSS viewport is whatever
 * the window ended up being. So a resize there is not one operation but four
 * that have to agree — the display, the kiosk browser, the page viewport, and
 * the capture geometry — and any pair of them disagreeing produces a picture
 * whose coordinates lie.
 *
 * ── Why this is possible at all ─────────────────────────────────────────
 * It was not, under Xvfb. Xvfb fixes its screen geometry when it starts, so
 * the only way to give a box a different display was to restart X — taking
 * the desktop, the kiosk browser and every open page with it, mid-session,
 * because somebody dragged a divider. The desktop image now boots TigerVNC's
 * Xvnc, which implements RandR on a running server and accepts a resize over
 * it. (https://tigervnc.org/doc/Xvnc.html)
 *
 * ── The order, and why it is this order ─────────────────────────────────
 * The display FIRST, then everything that reads it. A kiosk window told to
 * fill a screen that has not grown yet fills the old one, and a capture
 * started against a screen mid-resize reads torn frames. Going the other way
 * — page first, display last — is worse: the page reflows to a size the
 * display cannot show, and the right-hand strip of every screenshot is
 * missing, which is the failure mode that looks like nothing is wrong.
 *
 * ── What happens when it fails ──────────────────────────────────────────
 * The last CONFIRMED geometry is restored and the caller is told. Never a
 * half-applied transition: a display at one size with a page laid out for
 * another is a browser whose every coordinate is wrong, and it is wrong
 * silently. `NEVER PUBLISH DIMENSIONS THAT DISAGREE WITH THE DISPLAYED FRAME`
 * is the rule the whole responsive path rests on, and this is the place it is
 * easiest to break.
 */

import type { ViewportSize } from "../../../../shared/browser-viewport";

/** Run one command in the sandbox this daemon is inside. */
export type DisplayShell = (
  command: string,
) => Promise<{ exitCode: number; stderr?: string }>;

export interface DisplayResizeDeps {
  run: DisplayShell;
  display: string;
  /** Device pixels per CSS pixel. The display is the page times this. */
  deviceScaleFactor?: number;
  /**
   * Re-point the video encoder at the new geometry.
   *
   * Restarting it is what produces the fresh codec configuration and the
   * keyframe a decoder needs: an H.264 stream whose SPS says 1024 wide cannot
   * carry a 1400-wide frame, and a decoder handed one either drops it or
   * renders garbage. Frames from the previous generation are dropped by the
   * encoder itself; this only asks.
   */
  restartEncoder?: (size: ViewportSize) => Promise<void>;
  /** Tell the page adapter its viewport moved. */
  resizePage?: (size: ViewportSize) => Promise<void>;
}

export type DisplayResizeOutcome =
  | { ok: true; applied: ViewportSize }
  /**
   * Nothing moved, and the last confirmed geometry is still in force.
   *
   * `restored` says whether putting it back succeeded. A false there is the
   * one genuinely bad state — the display is at a size nothing else agrees
   * with — and the caller's job is to stop publishing dimensions rather than
   * to retry.
   */
  | { ok: false; reason: string; restored: boolean };

/**
 * The X screen size for a page of this size.
 *
 * The display and the page are the SAME rectangle scaled by the device pixel
 * ratio: a browser rendering at 1.5x on a 1024x768 screen paints past the edge
 * of what is captured, and the missing strip is on the right where nothing
 * looks obviously wrong.
 *
 * ODD PIXELS ARE ROUNDED UP, HERE AND NOWHERE ELSE. H.264's 4:2:0 chroma
 * sampling cannot represent an odd dimension, so an encoder handed 1401 either
 * refuses or silently crops a column — and a cropped column is a coordinate
 * space that disagrees with the page by one pixel forever. Rounding the
 * DISPLAY up leaves the page's logical size exactly what was asked for and
 * pays for it with at most one row and column of padding that nothing draws
 * in. The alternative, rounding the page, would mean a person dragging a
 * panel to an odd width gets a page one pixel narrower than their panel, and
 * every coordinate the model reads back is off by that pixel.
 */
export function displayGeometryFor(
  size: ViewportSize,
  options: { deviceScaleFactor?: number; depth?: number } = {},
): { width: number; height: number; depth: number } {
  const dpr = options.deviceScaleFactor ?? 1;
  const even = (value: number) => {
    const scaled = Math.round(value * dpr);
    return scaled % 2 === 0 ? scaled : scaled + 1;
  };
  return {
    width: even(size.width),
    height: even(size.height),
    depth: options.depth ?? 24,
  };
}

/** Escape a display name for a shell. Display names are `:0`-shaped; be sure. */
function shellSafeDisplay(display: string): string | null {
  return /^:[0-9]+(\.[0-9]+)?$/.test(display) ? display : null;
}

/**
 * Take the display, the browser, the page and the capture to a new size.
 *
 * `previous` is the last size everything agreed on — what to go back to when
 * a step refuses. It is a parameter rather than state because the session
 * viewport already holds it, and a second copy here would be a second opinion
 * about what "the current size" means.
 */
export async function resizeHostedDisplay(
  deps: DisplayResizeDeps,
  next: ViewportSize,
  previous: ViewportSize,
): Promise<DisplayResizeOutcome> {
  const display = shellSafeDisplay(deps.display);
  if (!display) {
    return {
      ok: false,
      reason: `refusing to resize a display named ${JSON.stringify(deps.display)}`,
      restored: true,
    };
  }
  const geometry = displayGeometryFor(next, {
    ...(deps.deviceScaleFactor !== undefined
      ? { deviceScaleFactor: deps.deviceScaleFactor }
      : {}),
  });

  const applyDisplay = async (size: {
    width: number;
    height: number;
  }): Promise<{ ok: boolean; reason?: string }> => {
    // `--fb` rather than `-s`, because `-s` only selects among the modes the
    // server already advertises and Xvnc advertises one. `--fb` sets the
    // framebuffer size directly, which is the RandR operation Xvnc implements
    // for exactly this.
    const command =
      `xrandr --display ${display} --fb ${size.width}x${size.height}`;
    try {
      const result = await deps.run(command);
      return result.exitCode === 0
        ? { ok: true }
        : {
            ok: false,
            reason:
              result.stderr?.trim() ||
              `xrandr exited ${result.exitCode} resizing to ${size.width}x${size.height}`,
          };
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const restore = async (): Promise<boolean> => {
    const back = displayGeometryFor(previous, {
      ...(deps.deviceScaleFactor !== undefined
        ? { deviceScaleFactor: deps.deviceScaleFactor }
        : {}),
    });
    const result = await applyDisplay(back);
    if (!result.ok) return false;
    // Best effort, and deliberately not checked: the page and the encoder are
    // being put back to a size they were already at, so a refusal here leaves
    // them where they are, which is where they should be.
    await deps.resizePage?.(previous).catch(() => {});
    await deps.restartEncoder?.(previous).catch(() => {});
    return true;
  };

  const display_ = await applyDisplay(geometry);
  if (!display_.ok) {
    // The display never moved, so there is nothing to put back — but the
    // restore runs anyway, because a partial `--fb` is a real state and
    // "xrandr failed" does not tell us which side of it we are on.
    return {
      ok: false,
      reason: display_.reason ?? "the display refused the new size",
      restored: await restore(),
    };
  }

  try {
    // THE PAGE BEFORE THE ENCODER. The encoder's restart is what mints the new
    // codec configuration and the keyframe, and it should describe the layout
    // that is actually on screen — a keyframe of a page mid-reflow is a
    // perfectly valid frame of the wrong thing, and it is the first thing
    // every watcher sees.
    await deps.resizePage?.(next);
    await deps.restartEncoder?.(next);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      restored: await restore(),
    };
  }
  return { ok: true, applied: next };
}
