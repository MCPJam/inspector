import { useEffect } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { addTokenToUrl, authFetch } from "@/lib/session-token";
import { executeInspectorCommand } from "@/lib/inspector-command-handlers";
import type {
  InspectorCommand,
  InspectorCommandResponse,
} from "@/shared/inspector-command.js";

function buildCommandBusClientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function postCommandResult(
  response: InspectorCommandResponse,
): Promise<void> {
  await authFetch("/api/mcp/command/result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(response),
  });
}

export function useInspectorCommandBus(): void {
  useEffect(() => {
    if (HOSTED_MODE) {
      return;
    }

    const clientId = buildCommandBusClientId();
    const eventSource = new EventSource(
      addTokenToUrl(
        `/api/mcp/subscribe?clientId=${encodeURIComponent(clientId)}`,
      ),
    );

    eventSource.onmessage = (event) => {
      void (async () => {
        let command: InspectorCommand;

        try {
          command = JSON.parse(event.data) as InspectorCommand;
        } catch (error) {
          console.warn("[inspector-command-bus] Invalid command payload", error);
          return;
        }

        const response = await executeInspectorCommand(command);

        try {
          await postCommandResult(response);
        } catch (error) {
          console.warn(
            "[inspector-command-bus] Failed to post command result",
            error,
          );
        }
      })();
    };

    eventSource.onerror = () => {
      console.debug(
        "[inspector-command-bus] command SSE connection error, browser will retry",
      );
    };

    eventSource.addEventListener("superseded", () => {
      eventSource.close();
    });

    return () => {
      eventSource.close();
    };
  }, []);
}
