/**
 * X-Ray Log Bus - Event bus for AI request inspection events.
 *
 * Follows the same pattern as rpc-log-bus.ts for consistency.
 * Provides pub/sub interface for X-ray events. Only stores the latest event.
 */

import { EventEmitter } from "events";
import type { XRayLogEvent } from "@/shared/xray-types";

class XRayLogBus {
  private readonly emitter = new EventEmitter();
  private latestEvent: XRayLogEvent | null = null;

  /**
   * Publish an X-ray event to all subscribers.
   * Overwrites the previous event.
   */
  publish(event: XRayLogEvent): void {
    console.log("[xray-log-bus] Publishing event:", event.id, event.path, event.model.id);
    console.log("[xray-log-bus] Messages:", JSON.stringify(event.messages, null, 2));
    console.log("[xray-log-bus] System prompt length:", event.systemPrompt?.length ?? 0);
    console.log("[xray-log-bus] Tools count:", event.tools.length);
    this.latestEvent = event;
    this.emitter.emit("event", event);
    console.log("[xray-log-bus] Listeners:", this.emitter.listenerCount("event"));
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
   * Get the latest event.
   */
  getLatest(): XRayLogEvent | null {
    return this.latestEvent;
  }

  /**
   * Clear the latest event.
   */
  clear(): void {
    this.latestEvent = null;
  }
}

export const xrayLogBus = new XRayLogBus();
