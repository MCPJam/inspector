/**
 * When background probes run for a capture context: after a connect when
 * this context has no results yet, when its results are older than a day, or
 * when the context changed (a new context is a new key); and always on
 * Refresh. One run per context at a time.
 *
 * The record is kept in this Inspector process and marked only after a
 * successful write, so a failed write or a restarted process runs the probes
 * again on the next connect rather than never. It is per process: with
 * several hosted replicas each keeps its own, so "once a day per context" is
 * once a day per context on each replica a connect reaches.
 */

export const PROBE_RESULTS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_CONTEXTS = 5_000;

export interface ProbeCadenceKey {
  projectId: string;
  serverId: string;
  contextHash: string;
}

function keyOf(key: ProbeCadenceKey): string {
  return JSON.stringify([key.projectId, key.serverId, key.contextHash]);
}

export class ProbeCadence {
  private readonly recordedAt = new Map<string, number>();
  private readonly running = new Set<string>();

  constructor(private readonly maxAgeMs = PROBE_RESULTS_MAX_AGE_MS) {}

  /** Whether a connect should probe this context. Refresh skips this question. */
  isDue(key: ProbeCadenceKey, now: number): boolean {
    const at = this.recordedAt.get(keyOf(key));
    return at === undefined || now - at >= this.maxAgeMs;
  }

  /** Claims the context for one run; false when a run is already going. */
  begin(key: ProbeCadenceKey): boolean {
    const id = keyOf(key);
    if (this.running.has(id)) return false;
    this.running.add(id);
    return true;
  }

  end(key: ProbeCadenceKey): void {
    this.running.delete(keyOf(key));
  }

  /** Results for this context were stored at `at`. */
  record(key: ProbeCadenceKey, at: number): void {
    const id = keyOf(key);
    this.recordedAt.delete(id);
    this.recordedAt.set(id, at);
    // Oldest first, by insertion order.
    while (this.recordedAt.size > MAX_REMEMBERED_CONTEXTS) {
      const oldest = this.recordedAt.keys().next().value;
      if (oldest === undefined) break;
      this.recordedAt.delete(oldest);
    }
  }
}

export const probeCadence = new ProbeCadence();
