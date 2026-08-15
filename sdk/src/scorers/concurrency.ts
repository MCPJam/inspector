/**
 * Counting semaphore shared by the iteration loop and the scorer runner.
 *
 * Lifted verbatim out of `EvalTest.ts` (where it was private) rather than
 * duplicated: the two schedulers now bound the same kind of thing — concurrent
 * work against a provider — and two copies would inevitably drift.
 */
export class Semaphore {
  private permits: number;
  private waiting: (() => void)[] = [];

  constructor(permits: number) {
    // A non-positive or non-finite permit count means every acquire() queues
    // forever and the caller hangs with no diagnostic. Fail loudly instead —
    // this also closes a pre-existing footgun on `EvalTest.run({concurrency: 0})`.
    if (!Number.isFinite(permits) || permits < 1) {
      throw new Error(
        `Semaphore requires at least 1 permit, got ${String(permits)}`
      );
    }
    this.permits = Math.floor(permits);
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}
