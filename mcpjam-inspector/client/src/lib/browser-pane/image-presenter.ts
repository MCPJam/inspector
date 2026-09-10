/** One active JPEG image load and one replaceable pending picture. */
export function createImagePresenter<T extends { src: string }>(
  paint: (image: HTMLImageElement, frame: T, decodeMs: number) => void,
) {
  let active: HTMLImageElement | undefined;
  let pending: T | undefined;
  let generation = 0;
  let presentation: number | undefined;
  const start = (frame: T) => {
    const image = new Image();
    const mine = generation;
    const startedAt = performance.now();
    active = image;
    const finish = (loaded: boolean) => {
      if (mine !== generation || active !== image) return;
      image.onload = image.onerror = null;
      const decodeMs = performance.now() - startedAt;
      const present = () => {
        presentation = undefined;
        if (mine !== generation || active !== image) return;
        active = undefined;
        // Paint the completed load before decoding the newest pending frame.
        // Discarding every completed load while another is pending starves a
        // viewer whose decode takes longer than the capture interval.
        if (loaded) {
          try {
            paint(image, frame, decodeMs);
          } catch {
            /* A retired canvas must not block the next image. */
          }
        }
        const next = pending;
        pending = undefined;
        if (next) start(next);
      };
      // Keep the input-to-paint boundary at the animation frame, as in the
      // original inspection viewer. Decode completion is not presentation.
      if (loaded) presentation = requestAnimationFrame(present);
      else present();
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = frame.src;
  };
  return {
    push(frame: T) {
      if (active) pending = frame;
      else start(frame);
    },
    clear() {
      generation++;
      if (presentation !== undefined) cancelAnimationFrame(presentation);
      presentation = undefined;
      pending = undefined;
      if (active) {
        active.onload = active.onerror = null;
        active.src = "";
        active = undefined;
      }
    },
  };
}
