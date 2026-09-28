/** A deadline measured only while awake and online. Connectivity is sampled at
 * most every 30 seconds, including immediately before a deadline fires. */
export class UpdateClock {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private last = Date.now();
  private suspended = false;
  private offline: boolean;
  private remaining: number | undefined;
  private expired: (() => void) | undefined;

  constructor(
    private readonly isOnline: () => boolean,
    private readonly record: (
      active: number,
      sleep: number,
      offline: number,
    ) => void,
  ) {
    this.offline = !isOnline();
  }

  start(ms: number, expired: () => void): void {
    this.stop();
    this.remaining = ms;
    this.expired = expired;
    this.last = Date.now();
    this.offline = !this.isOnline();
    this.schedule();
  }

  private sample(): void {
    const now = Date.now();
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    const offline = !this.isOnline();
    if (this.remaining !== undefined) {
      // Conservatively exclude an interval if either endpoint was offline.
      if (this.suspended) this.record(0, elapsed, 0);
      else if (this.offline || offline) this.record(0, 0, elapsed);
      else {
        this.record(elapsed, 0, 0);
        this.remaining = Math.max(0, this.remaining - elapsed);
      }
    }
    this.offline = offline;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.remaining === undefined) return;
    const delay =
      this.suspended || this.offline
        ? 30_000
        : Math.min(30_000, this.remaining);
    this.timer = setTimeout(() => {
      this.sample();
      if (!this.suspended && !this.offline && this.remaining === 0) {
        const expired = this.expired;
        this.remaining = undefined;
        this.expired = undefined;
        this.timer = undefined;
        expired?.();
      } else this.schedule();
    }, delay);
  }

  suspend(): void {
    this.sample();
    this.suspended = true;
    this.schedule();
  }

  resume(): void {
    this.sample();
    this.suspended = false;
    this.schedule();
  }

  stop(): void {
    this.sample();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining = undefined;
    this.expired = undefined;
  }
}
