import { EventEmitter } from "events";

export type ProgressEvent = {
  serverId: string;
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
  timestamp: string;
};

/**
 * In-memory store for progress notifications.
 * Stores the latest progress per serverId + progressToken combination.
 * Also emits events for real-time streaming to clients.
 */
class ProgressStore {
  private readonly emitter = new EventEmitter();
  // Map: serverId -> Map<progressToken, ProgressEvent>
  private readonly store = new Map<string, Map<string | number, ProgressEvent>>();

  /**
   * Store a progress update
   */
  publish(event: ProgressEvent): void {
    let serverProgress = this.store.get(event.serverId);
    if (!serverProgress) {
      serverProgress = new Map();
      this.store.set(event.serverId, serverProgress);
    }
    serverProgress.set(event.progressToken, event);
    this.emitter.emit("progress", event);
  }

  /**
   * Get the latest progress for a specific progressToken
   */
  getProgress(serverId: string, progressToken: string | number): ProgressEvent | undefined {
    return this.store.get(serverId)?.get(progressToken);
  }

  /**
   * Get all active progress for a server
   */
  getAllProgress(serverId: string): ProgressEvent[] {
    const serverProgress = this.store.get(serverId);
    if (!serverProgress) return [];
    return Array.from(serverProgress.values());
  }

  /**
   * Get the most recent progress event for a server (useful when we don't know the token)
   */
  getLatestProgress(serverId: string): ProgressEvent | undefined {
    const all = this.getAllProgress(serverId);
    if (all.length === 0) return undefined;
    // Return the most recent by timestamp
    return all.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];
  }

  /**
   * Clear progress for a specific token (e.g., when task completes)
   */
  clearProgress(serverId: string, progressToken: string | number): void {
    this.store.get(serverId)?.delete(progressToken);
  }

  /**
   * Clear all progress for a server
   */
  clearAllProgress(serverId: string): void {
    this.store.delete(serverId);
  }

  /**
   * Subscribe to progress events
   */
  subscribe(
    serverIds: string[],
    listener: (event: ProgressEvent) => void
  ): () => void {
    const filter = new Set(serverIds);
    const handler = (event: ProgressEvent) => {
      if (filter.size === 0 || filter.has(event.serverId)) {
        listener(event);
      }
    };
    this.emitter.on("progress", handler);
    return () => this.emitter.off("progress", handler);
  }
}

export const progressStore = new ProgressStore();
