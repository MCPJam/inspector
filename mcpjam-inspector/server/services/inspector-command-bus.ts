import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";
import {
  INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS,
  buildInspectorCommandError,
} from "@/shared/inspector-command.js";
import type { InspectorEvent } from "@/shared/inspector-event.js";
import { logger } from "../utils/logger.js";

type Subscriber = {
  clientId: string;
  send: (command: InspectorCommand) => void;
  sendEvent: (event: InspectorEvent) => void;
  supersede: () => void;
  close: () => void;
};

type PendingCommand = {
  resolve: (response: InspectorCommandResponse) => void;
  timeout: NodeJS.Timeout;
};

/**
 * Maintains a single active Inspector SSE subscriber.
 *
 * @note `registerSubscriber` evicts the previous subscriber, records evicted
 * client ids in `supersededClientIds`, and rejects `pending` commands when the
 * active subscriber disconnects. Callers are expected to send `supersede()`
 * before `close()` so the browser can observe the replacement protocol.
 */
export class InspectorCommandBus {
  private subscriber: Subscriber | null = null;
  private pending = new Map<string, PendingCommand>();
  private supersededClientIds = new Set<string>();

  hasActiveClient(): boolean {
    return this.subscriber !== null;
  }

  /** Best-effort one-way delivery; events never create pending command state. */
  notify(event: InspectorEvent): boolean {
    if (!this.subscriber) return false;
    try {
      this.subscriber.sendEvent(event);
      return true;
    } catch (error) {
      logger.debug("[inspector-command-bus] Event delivery threw", {
        kind: event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  registerSubscriber(subscriber: Subscriber): () => void {
    if (this.supersededClientIds.has(subscriber.clientId)) {
      if (this.subscriber?.clientId !== subscriber.clientId) {
        subscriber.supersede();
        subscriber.close();
        return () => {};
      }
      this.supersededClientIds.delete(subscriber.clientId);
    }

    if (this.subscriber) {
      const previousSubscriber = this.subscriber;
      logger.debug(
        "[inspector-command-bus] Evicting previous subscriber; only one active client is supported.",
        {
          clientId: previousSubscriber.clientId,
          sameClientReconnect:
            previousSubscriber.clientId === subscriber.clientId,
        },
      );
      if (previousSubscriber.clientId !== subscriber.clientId) {
        this.markSuperseded(previousSubscriber.clientId);
        this.rejectAll(
          "no_active_client",
          "The active Inspector client was replaced before the command completed.",
        );
      }
      try {
        previousSubscriber.supersede();
        previousSubscriber.close();
      } catch (error) {
        logger.debug("[inspector-command-bus] Subscriber eviction threw", {
          clientId: previousSubscriber.clientId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.subscriber = subscriber;

    return () => {
      if (this.subscriber !== subscriber) return;
      this.subscriber = null;
      this.rejectAll(
        "no_active_client",
        "The active Inspector client disconnected before the command completed.",
      );
    };
  }

  async submit(
    command: InspectorCommand,
    timeoutMs = INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS,
  ): Promise<InspectorCommandResponse> {
    if (!this.subscriber) {
      return this.createErrorResponse(
        command.id,
        "no_active_client",
        "No active Inspector client is subscribed. Open the Inspector UI first.",
      );
    }

    return await new Promise<InspectorCommandResponse>((resolve) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.id);
        resolve(
          this.createErrorResponse(
            command.id,
            "timeout",
            `Inspector command timed out after ${timeoutMs}ms.`,
          ),
        );
      }, timeoutMs);

      this.pending.set(command.id, { resolve, timeout });

      try {
        this.subscriber?.send(command);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(command.id);
        resolve(
          this.createErrorResponse(
            command.id,
            "execution_failed",
            error instanceof Error
              ? error.message
              : "Failed to deliver command to the Inspector client.",
          ),
        );
      }
    });
  }

  complete(response: InspectorCommandResponse): boolean {
    const pending = this.pending.get(response.id);
    if (!pending) return false;

    clearTimeout(pending.timeout);
    this.pending.delete(response.id);
    pending.resolve(response);
    return true;
  }

  private rejectAll(
    code: Parameters<typeof buildInspectorCommandError>[0],
    message: string,
  ): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.resolve(this.createErrorResponse(id, code, message));
    }
  }

  private createErrorResponse(
    id: string,
    code: Parameters<typeof buildInspectorCommandError>[0],
    message: string,
  ): InspectorCommandResponse {
    return {
      id,
      status: "error",
      error: buildInspectorCommandError(code, message),
    };
  }

  private markSuperseded(clientId: string): void {
    this.supersededClientIds.add(clientId);
    setTimeout(() => {
      this.supersededClientIds.delete(clientId);
    }, 60_000).unref?.();
  }
}

export const inspectorCommandBus = new InspectorCommandBus();
