/** One active JPEG image load and one replaceable pending picture. */
export function createImagePresenter<T extends { src: string }>(
  paint: (image: HTMLImageElement, frame: T, decodeMs: number) => void,
) {
  let active: HTMLImageElement | undefined;
  let pending: T | undefined;
  let generation = 0;
  const start = (frame: T) => {
    const image = new Image();
    const mine = generation;
    const startedAt = performance.now();
    active = image;
    const finish = (loaded: boolean) => {
      if (mine !== generation || active !== image) return;
      active = undefined;
      image.onload = image.onerror = null;
      // Paint the completed load before decoding the newest pending frame.
      // Discarding every completed load while another is pending starves a
      // viewer whose decode takes longer than the capture interval.
      if (loaded) {
        try {
          paint(image, frame, performance.now() - startedAt);
        } catch {
          /* A retired canvas must not block the next image. */
        }
      }
      const next = pending;
      pending = undefined;
      if (next) start(next);
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
      pending = undefined;
      if (active) {
        active.onload = active.onerror = null;
        active.src = "";
        active = undefined;
      }
    },
  };
}
