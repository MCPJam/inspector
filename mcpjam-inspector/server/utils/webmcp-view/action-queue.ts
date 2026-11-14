/** Serializes actions without letting cancelled work hold the next caller open. */
export class ViewActionQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;
  private active = new Set<AbortController>();

  invalidate(): void {
    this.generation++;
    for (const controller of this.active)
      controller.abort(new Error("View closed or replaced"));
  }

  async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: {
      signal?: AbortSignal;
      timeoutMs?: number;
      onUncertainStop?: () => Promise<void>;
    } = {},
  ): Promise<T> {
    const generation = this.generation;
    const controller = new AbortController();
    const abort = () =>
      controller.abort(
        options.signal?.reason ?? new Error("View action cancelled"),
      );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new Error("View action timed out")),
      options.timeoutMs ?? 30000,
    );
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.active.add(controller);
    let began = false;
    let stop: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      stop = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", stop, { once: true });
      if (controller.signal.aborted) stop();
    });
    try {
      await Promise.race([previous, stopped]);
      if (generation !== this.generation)
        throw new Error("View closed or replaced");
      controller.signal.throwIfAborted();
      began = true;
      return await Promise.race([operation(controller.signal), stopped]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (stop) controller.signal.removeEventListener("abort", stop);
      this.active.delete(controller);
      try {
        if (began && controller.signal.aborted)
          await options.onUncertainStop?.();
      } finally {
        // A cancelled queued action still waits for its predecessor before it
        // releases its successor; otherwise it would break serialization.
        void previous.then(release);
      }
    }
  }
}
