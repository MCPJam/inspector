/**
 * Turn raw JPEG bytes into something an `<img>` can show, without leaking the
 * object URLs behind them.
 *
 * WHY BLOB URLS AND NOT A CANVAS. Drawing frames into a canvas would mean
 * reimplementing the `object-contain` letterbox arithmetic that
 * `toFrameCoordinates` and the pane's geometry closure both depend on — the
 * one piece of this feature where being subtly wrong puts every click a few
 * pixels off with nothing to notice it. A blob URL changes only the `src`, so
 * the browser keeps doing the fitting and the coordinate contract is untouched.
 *
 * WHY THE REVOKES ARE DELAYED. `URL.revokeObjectURL` invalidates the URL
 * immediately, and an `<img decoding="async">` may still be decoding the one
 * it was handed. Revoking the URL a frame is currently painted from gives a
 * broken image, so:
 *   - creating URL N revokes URL N−2, never N−1: N−1 may still be on screen
 *     while N decodes;
 *   - `clear()` defers its revokes by one task, so React has dropped the `src`
 *     before the bytes go away.
 * Neither is a guess about decode timing — both are "one step behind whatever
 * the browser might still be holding".
 */

export interface FramePresenter {
  /** Take ownership of one frame's bytes and return a URL to render. */
  present(jpeg: Uint8Array): string;
  /**
   * Release every URL this presenter still owns.
   *
   * Call AFTER dropping the rendered `src`, never before: the revokes land on
   * a later task precisely so the element has stopped referencing them.
   */
  clear(): void;
}

export interface FramePresenterOptions {
  /** Injected for tests; defaults to the browser's own. */
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  /** Injected for tests; defaults to `setTimeout(fn, 0)`. */
  defer?: (fn: () => void) => void;
}

export function createFramePresenter(
  options: FramePresenterOptions = {},
): FramePresenter {
  const createUrl =
    options.createUrl ?? ((blob: Blob) => URL.createObjectURL(blob));
  const revokeUrl =
    options.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const defer = options.defer ?? ((fn: () => void) => void setTimeout(fn, 0));

  /** The two most recent URLs, oldest first. See the module comment. */
  let previous: string | undefined;
  let current: string | undefined;

  return {
    present(jpeg) {
      // `slice()` — a right-sized copy — and NOT `jpeg.buffer`. A decoded
      // frame is routinely a view onto a larger pooled allocation, and its
      // `.buffer` is that whole allocation: the frame plus whatever bytes
      // happen to surround it. Ownership is not the reason; the Blob
      // constructor copies its input either way.
      const url = createUrl(new Blob([jpeg.slice()], { type: "image/jpeg" }));
      if (previous) revokeUrl(previous);
      previous = current;
      current = url;
      return url;
    },

    clear() {
      const stale = [previous, current].filter(
        (url): url is string => url !== undefined,
      );
      previous = undefined;
      current = undefined;
      if (stale.length === 0) return;
      // One task later: a synchronous revoke here would yank the bytes out from
      // under an element that has not yet been re-rendered without them.
      defer(() => {
        for (const url of stale) revokeUrl(url);
      });
    },
  };
}
