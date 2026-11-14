import type { ToolExecutionResponse } from "@/lib/apis/mcp-tools-api";
import { presentAuthChallenge } from "@/lib/auth-challenge-lifecycle";
import {
  claimPendingDirectScopeStepUpReplay,
  clearPendingDirectScopeStepUpReplay,
  peekPendingDirectScopeStepUpReplay,
} from "@/lib/scope-step-up-replay";
import type { useOptionalSharedAppState } from "@/state/app-state-context";
import { useCallback, useEffect } from "react";
import type {
  UseToolExecutionOptions,
  UseToolExecutionReturn,
} from "./useToolExecution";

import { useUIPlaygroundStore } from "@/stores/ui-playground-store";
import {
  applyParametersToFields,
  generateFormFieldsFromSchema,
} from "@/lib/tool-form";

type SharedState = Pick<
  NonNullable<ReturnType<typeof useOptionalSharedAppState>>,
  "servers"
> | null;
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
        { readOnlyHint?: unknown } | undefined;
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
  activeServerNames: readonly string[],
  serverName: string | undefined,
  sharedAppState: SharedState,
  executeTool: UseToolExecutionReturn["executeTool"],
) {
  const tools = useUIPlaygroundStore((state) => state.tools);
  const servers = sharedAppState?.servers;
  useEffect(() => {
    const waiting = peekPendingDirectScopeStepUpReplay();
    if (waiting?.descriptor.kind !== "tool") return;
    // Keyed to the saved call's own server: the multi-server rail runs tools
    // on every active server, not only the selected one.
    const target = waiting.descriptor.serverName;
    if (!activeServerNames.includes(target)) return;
    if (servers?.[target]?.connectionStatus !== "connected") return;
    // The selected server's form is built from its own tool list, so wait
    // for it. The rail builds its form from the recovered call instead.
    const currentTools = useUIPlaygroundStore.getState().tools;
    const isSelectedServer = target === serverName;
    if (isSelectedServer && !currentTools[waiting.descriptor.toolName]) return;
    const pending = claimPendingDirectScopeStepUpReplay({
      serverName: target,
      surface: "playground",
    });
    if (!pending || pending.descriptor.kind !== "tool") return;
    const descriptor = pending.descriptor;
    const state = useUIPlaygroundStore.getState();
    if (isSelectedServer) state.setSelectedTool(descriptor.toolName);
    useUIPlaygroundStore.setState({
      recoveredToolCall: {
        serverName: descriptor.serverName,
        toolName: descriptor.toolName,
        parameters: descriptor.parameters,
      },
    });
    if (isSelectedServer) {
      state.setFormFields(
        applyParametersToFields(
          generateFormFieldsFromSchema(
            currentTools[descriptor.toolName].inputSchema,
          ),
          descriptor.parameters,
        ),
      );
    }
    // Reads and writes both run again: the user already asked for this call,
    // and the client's tool-approval policy still applies to it.
    void executeTool({
      serverName: descriptor.serverName,
      toolName: descriptor.toolName,
      parameters: descriptor.parameters,
      scopeStepUpReplay: true,
      authAttempt: descriptor.authAttempt,
    }).finally(() => {
      clearPendingDirectScopeStepUpReplay(pending);
    });
  }, [activeServerNames, executeTool, serverName, servers, tools]);
}
