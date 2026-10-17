import type { ToolExecutionResponse } from "@/lib/apis/mcp-tools-api";
import { presentAuthChallenge } from "@/lib/auth-challenge-lifecycle";
import {
  claimPendingDirectScopeStepUpReplay,
  clearPendingDirectScopeStepUpReplay,
  peekPendingDirectScopeStepUpReplay,
} from "@/lib/scope-step-up-replay";
import type { useOptionalSharedAppState } from "@/state/app-state-context";
import { useCallback, useEffect } from "react";
import { toast } from "sonner";
import type {
  UseToolExecutionOptions,
  UseToolExecutionReturn,
} from "./useToolExecution";

type SharedState = ReturnType<typeof useOptionalSharedAppState>;
export function useToolAuthChallengePresentation(
  sharedAppState: SharedState,
  tools: UseToolExecutionOptions["tools"],
  setExecutionError: UseToolExecutionOptions["setExecutionError"],
) {
  // A mid-session sign-in challenge on this call: a Connect card in the
  // tools rail, or the reason there is none. Returns whether the response
  // carried one (a challenged result is not a success).
  const presentAuthChallengeFromResponse = useCallback(
    (
      name: string,
      toolName: string,
      parameters: Record<string, unknown>,
      response: ToolExecutionResponse,
    ): boolean => {
      const signal =
        "authChallenge" in response ? response.authChallenge : undefined;
      if (!signal || signal.source === "http_403_insufficient_scope") {
        return false;
      }
      const annotations = tools?.[toolName]?.annotations as
        | { readOnlyHint?: unknown }
        | undefined;
      void presentAuthChallenge({
        server: sharedAppState?.servers[name],
        signal,
        surface: "playground",
        operation: { method: "tools/call", operation: toolName },
        readOnly: annotations?.readOnlyHint === true,
        ...("toolSecuritySchemes" in response && response.toolSecuritySchemes
          ? { schemes: response.toolSecuritySchemes }
          : {}),
        replay: {
          kind: "tool",
          surface: "playground",
          serverName: name,
          toolName,
          parameters,
        },
      }).then((presentation) => {
        if (presentation.kind === "notice") {
          setExecutionError(presentation.message);
        }
      });
      return true;
    },
    [sharedAppState, setExecutionError, tools],
  );

  return presentAuthChallengeFromResponse;
}

export function useToolAuthChallengeReplay(
  serverName: string | undefined,
  sharedAppState: SharedState,
  executeTool: UseToolExecutionReturn["executeTool"],
) {
  useEffect(() => {
    if (!serverName) return;
    const liveServer = sharedAppState?.servers[serverName];
    if (liveServer?.connectionStatus !== "connected") return;
    // A call that may change something is never re-run on its own after a
    // sign-in: the user confirms it first.
    const waiting = peekPendingDirectScopeStepUpReplay();
    if (
      waiting?.phase === "ready" &&
      waiting.requiresConfirmation &&
      waiting.descriptor.kind === "tool" &&
      waiting.descriptor.serverName === serverName &&
      waiting.descriptor.surface === "playground"
    ) {
      const toolName = waiting.descriptor.toolName;
      toast(`Signed in. Run ${toolName} again?`, {
        id: `auth-challenge-run-again:${serverName}`,
        duration: Infinity,
        action: {
          label: "Run again",
          onClick: () => {
            const claimed = claimPendingDirectScopeStepUpReplay({
              serverName,
              surface: "playground",
            });
            if (!claimed || claimed.descriptor.kind !== "tool") return;
            const descriptor = claimed.descriptor;
            void executeTool({
              serverName: descriptor.serverName,
              toolName: descriptor.toolName,
              parameters: descriptor.parameters,
              scopeStepUpReplay: true,
              authAttempt: descriptor.authAttempt,
            }).finally(() => {
              clearPendingDirectScopeStepUpReplay(claimed);
            });
          },
        },
        cancel: {
          label: "Not now",
          onClick: () => clearPendingDirectScopeStepUpReplay(waiting),
        },
      });
      return;
    }
    const pending = claimPendingDirectScopeStepUpReplay({
      serverName,
      surface: "playground",
    });
    if (!pending || pending.descriptor.kind !== "tool") return;
    const descriptor = pending.descriptor;
    void executeTool({
      serverName: descriptor.serverName,
      toolName: descriptor.toolName,
      parameters: descriptor.parameters,
      scopeStepUpReplay: true,
      authAttempt: descriptor.authAttempt,
    }).finally(() => {
      clearPendingDirectScopeStepUpReplay(pending);
    });
  }, [executeTool, serverName, sharedAppState]);
}
