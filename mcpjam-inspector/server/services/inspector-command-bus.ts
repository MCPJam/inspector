import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";
import {
  INSPECTOR_COMMAND_DEFAULT_TIMEOUT_MS,
  buildInspectorCommandError,
} from "@/shared/inspector-command.js";

type Subscriber = {
  clientId: string;
  send: (command: InspectorCommand) => void;
  supersede: () => void;
  close: () => void;
};

type PendingCommand = {
  resolve: (response: InspectorCommandResponse) => void;
  timeout: NodeJS.Timeout;
};

export class InspectorCommandBus {
  private subscriber: Subscriber | null = null;
  private pending = new Map<string, PendingCommand>();
  private supersededClientIds = new Set<string>();

  hasActiveClient(): boolean {
    return this.subscriber !== null;
  }

  registerSubscriber(subscriber: Subscriber): () => void {
    if (this.supersededClientIds.has(subscriber.clientId)) {
      subscriber.supersede();
      subscriber.close();
      return () => {};
    }

    if (this.subscriber) {
      console.debug(
        "[inspector-command-bus] Evicting previous subscriber — only one active client is supported.",
      );
      this.markSuperseded(this.subscriber.clientId);
      try {
        this.subscriber.supersede();
        this.subscriber.close();
      } catch {}
    }

    this.subscriber = subscriber;

    return () => {
      if (this.subscriber !== subscriber) return;
      this.subscriber = null;
      this.rejectAll(
        this.createErrorResponse(
          "",
          "no_active_client",
          "The active Inspector client disconnected before the command completed.",
        ),
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

  private rejectAll(response: InspectorCommandResponse): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      this.pending.delete(id);
      pending.resolve({ ...response, id });
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
