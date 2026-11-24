/**
 * The mock route's counters over HTTP: a fixed window per key. In process
 * memory, per replica, like every limiter beside the harness proxy. A spike
 * brake, not a budget.
 */

export const MOCK_KEY_LIMIT_PER_MINUTE = 600;
export const MOCK_SOURCE_LIMIT_PER_MINUTE = 60;
const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;
const OVERFLOW_KEY = "_overflow";

type Window = { count: number; windowStart: number };

export class WindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Counts one request. Returns the milliseconds until the window ends when
   * the key is over its limit, else null. A table that is full of live keys
   * sends new keys to one shared window (four times the limit) rather than
   * evicting a key that is over its limit.
   */
  take(rawKey: string): number | null {
    const at = this.now();
    let key = rawKey;
    let limit = this.limit;
    let window = this.windows.get(key);
    if (!window && this.windows.size >= MAX_KEYS) {
      this.prune(at);
      if (this.windows.size >= MAX_KEYS) {
        key = OVERFLOW_KEY;
        limit = this.limit * 4;
        window = this.windows.get(key);
      }
    }
    if (!window || at - window.windowStart >= WINDOW_MS) {
      this.windows.set(key, { count: 1, windowStart: at });
      return null;
    }
    if (window.count >= limit) return window.windowStart + WINDOW_MS - at;
    window.count += 1;
    return null;
  }

  private prune(at: number) {
    for (const [key, window] of this.windows) {
      if (at - window.windowStart >= WINDOW_MS) this.windows.delete(key);
    }
  }

  clear() {
    this.windows.clear();
  }
}
