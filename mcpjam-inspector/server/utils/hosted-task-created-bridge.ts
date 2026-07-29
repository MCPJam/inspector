/**
 * Delivers a created task to the browser as a transient stream part.
 *
 * Structurally the same shape as `mrtr-hosted-bridge.ts` — a writer attached
 * when the stream is ready, a `transient: true` part, a try/catch that nulls a
 * dead writer — because the failure modes are the same: a stream that closed
 * mid-turn must degrade to a dropped part, never to a thrown turn.
 *
 * Registered on the task-created sink as a FUNCTIONAL consumer, not a
 * best-effort one. "Best effort" describes the hosted registry, which is a
 * recovery index; this is the path the user's own next page load depends on to
 * know the task exists at all.
 */

import type { UIMessageChunk } from "ai";
import type { TaskCreatedEvent } from "@mcpjam/sdk";

import {
  HOSTED_TASK_CREATED_DATA_PART_TYPE,
  type TaskCreatedPayload,
} from "../../shared/hosted-task-created.js";
import { logger } from "./logger.js";

type ChunkWriter = { write: (chunk: UIMessageChunk) => void };

export interface HostedTaskCreatedBridgeOptions {
  /**
   * Display names by server id. The tracker is keyed by NAME, so a task
   * delivered with only a Convex document id lands where the Tasks tab never
   * looks — see `TaskCreatedPayload.serverName`.
   */
  serverNamesById: Record<string, string>;
}

export class HostedTaskCreatedBridge {
  private writer: ChunkWriter | null = null;

  constructor(private readonly options: HostedTaskCreatedBridgeOptions) {}

  attachStreamWriter(writer: ChunkWriter): void {
    this.writer = writer;
  }

  /** The sink consumer. Bind this, not the class, when registering. */
  handle = (event: TaskCreatedEvent): void => {
    this.emit({
      taskId: event.identity.taskId,
      serverId: event.identity.serverId,
      ...(this.options.serverNamesById[event.identity.serverId]
        ? { serverName: this.options.serverNamesById[event.identity.serverId] }
        : {}),
      wire: event.wire,
      ...(event.createdAt !== undefined ? { createdAt: event.createdAt } : {}),
      ...(event.status !== undefined ? { status: event.status } : {}),
      ...(event.toolName !== undefined ? { toolName: event.toolName } : {}),
      ...(event.ttlMs !== undefined ? { ttlMs: event.ttlMs } : {}),
      ...(event.pollIntervalMs !== undefined
        ? { pollIntervalMs: event.pollIntervalMs }
        : {}),
    });
  };

  private emit(payload: TaskCreatedPayload): void {
    if (!this.writer) {
      logger.warn(
        "[task-created-bridge] emit with no live stream writer; dropping part",
      );
      return;
    }
    try {
      this.writer.write({
        type: HOSTED_TASK_CREATED_DATA_PART_TYPE,
        data: payload,
        // Transient: the handle is delivered for tracking, not persisted into
        // the conversation. Live state is always read back from `tasks/get`.
        transient: true,
      } as unknown as UIMessageChunk);
    } catch (error) {
      logger.warn("[task-created-bridge] stream write failed", { error });
      this.writer = null;
    }
  }
}
