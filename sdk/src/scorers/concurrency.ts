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
    this.permits = permits;
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
