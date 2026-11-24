/**
 * Answers the route keeps for a short time, each with its expiry. An answer,
 * never a credential. In process memory, per replica.
 */

export const MOCK_REFUSED_BEARER_MS = 30_000;
const MAX_ANSWERS = 1_000;

export class AnswerCache<T> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = () => Date.now(),
    private readonly capacity = MAX_ANSWERS,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** `notAfter` shortens the entry's life, as a grant's own expiry must. */
  set(key: string, value: T, notAfter?: number) {
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    const expiresAt = Math.min(this.now() + this.ttlMs, notAfter ?? Infinity);
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt });
  }

  clear() {
    this.entries.clear();
  }
}
