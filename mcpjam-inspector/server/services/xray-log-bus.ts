/**
 * X-Ray Log Bus - Event bus for AI request inspection events.
 *
 * Follows the same pattern as rpc-log-bus.ts for consistency.
 * Provides pub/sub interface for X-ray events with replay buffer support.
 */

import { EventEmitter } from "events";
import type { XRayLogEvent } from "@/shared/xray-types";

const MAX_BUFFER_SIZE = 50;

class XRayLogBus {
  private readonly emitter = new EventEmitter();
  private readonly buffer: XRayLogEvent[] = [];

  /**
   * Publish an X-ray event to all subscribers.
   */
  publish(event: XRayLogEvent): void {
    console.log("[xray-log-bus] Publishing event:", event.id, event.path, event.model.id);
    console.log("[xray-log-bus] Messages:", JSON.stringify(event.messages, null, 2));
    console.log("[xray-log-bus] System prompt length:", event.systemPrompt?.length ?? 0);
    console.log("[xray-log-bus] Tools count:", event.tools.length);
    this.buffer.push(event);
    // Keep buffer size bounded
    while (this.buffer.length > MAX_BUFFER_SIZE) {
      this.buffer.shift();
    }
    this.emitter.emit("event", event);
    console.log("[xray-log-bus] Buffer size:", this.buffer.length, "Listeners:", this.emitter.listenerCount("event"));
  }

  /**
   * Subscribe to X-ray events.
   * Returns an unsubscribe function.
   */
  subscribe(listener: (event: XRayLogEvent) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  /**
   * Get recent events from the buffer for replay.
   * @param limit Maximum number of events to return (0 = none, negative/Infinity = all)
   */
  getBuffer(limit: number): XRayLogEvent[] {
    // If limit is 0, return empty array (no replay)
    if (limit === 0) return [];
    // If limit is not finite or negative, return all
    if (!Number.isFinite(limit) || limit < 0) return [...this.buffer];
    // Return last `limit` events
    return this.buffer.slice(Math.max(0, this.buffer.length - limit));
  }

  /**
   * Clear the buffer (useful for testing).
   */
  clear(): void {
    this.buffer.length = 0;
  }
}

export const xrayLogBus = new XRayLogBus();
