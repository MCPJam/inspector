/**
 * EvalLiveChatPanel — embeds the live Playground chat surface inside the eval
 * test-editor, bound to the current case (its servers + the case prompt
 * prefilled). Shown when the editor's **Record** toggle is on, in place of the
 * frozen trace-replay Chat surface.
 *
 * Why: recording a widget interaction used to require a full GRADED run
 * (`startRecording` → arm → `handleRunCompare`). That's slow and backwards.
 * This reuses the SAME surface the Playground and Views use (`PlaygroundMain` →
 * chat-v2 `Thread`) so the widget renders live and interactive — but case-bound,
 * so the widget you click is the one the suite replays. Grading lives only in
 * the eval runner, which this path never touches, so live == ungraded.
 *
 * Self-sources app-state via `useSharedAppState()` (servers, host,
 * ensureServersReady) and the preference stores, mirroring how `PlaygroundTab`
 * builds `usePlaygroundState` + its provider stack — minus the IDE rails/logger,
 * which don't belong in a docked panel. Renders `PlaygroundMain` directly so the
 * editor can prefill the case prompt, auto-run, bind the case model/settings,
 * and thread the recorder.
 *
 * What flows in from the editor:
 * - `initialPrompt` / `autoRun` — prefill, or auto-send when the case renders a
 *   widget (so the widget mounts without a manual send).
 * - `evalChatHandoff` — binds the case's model / system / temperature /
 *   tool-approval before auto-run (config-only handoff: empty messages).
 * - `recorder` — record-capable bundle; the armed widget's interaction steps
 *   are saved back into the case (host-side save gate in the editor).
 * - `onCaptureTurns` — reflects the live conversation back into the case spec.
 *
 * Mount with a STABLE `key` (the case id) so toggling Record / switching tabs
 * doesn't remount and mint a fresh `chatSessionId` (which would wipe in-flight
 * widget/cart state). Server selection / connection is owned by the editor —
 * this panel does not connect on its own beyond the `ensureServersReady` it is
 * handed.
 *
 * Metrics: this is a real, case-bound Playground chat, so it counts as normal
 * chat activity (evals are first-class billable; we don't special-case
 * surfaces). It does NOT write a test iteration, so it never pollutes eval-suite
 * pass-rate / run history — only the graded Quick Run produces eval results.
 */
import { useCallback } from "react";
import type { UIMessage } from "ai";
import type { RecorderProps } from "@/components/chat-v2/thread/recorder-types";
import { useConvexAuth } from "convex/react";
import {
  isDynamicTool,
  isToolPart,
  getToolInfo,
} from "@/components/chat-v2/thread/thread-helpers";
import type { PromptTurnToolCall } from "@/shared/steps";
import {
  PlaygroundStateProvider,
  usePlaygroundState,
} from "@/components/ui-playground/hooks/use-playground-state";
import {
  ChatboxChatUiOverrideProvider,
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-client-capabilities-override-context";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";
import { ActiveHostCapsResolverScope } from "@/contexts/active-host-client-capabilities-context";
import { getChatboxShellStyle } from "@/lib/chatbox-client-style";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useSharedAppState } from "@/state/app-state-context";
import { PlaygroundMain } from "@/components/ui-playground/PlaygroundMain";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";

export interface EvalLiveChatPanelProps {
  /** Case project (threaded from the editor; AppState context doesn't carry it). */
  projectId?: string | null;
  /** The case's servers — scopes the tools pane + execution to this case. */
  caseServerNames?: string[];
  /** The case's prompt. Prefilled into the composer, or auto-sent if `autoRun`. */
  initialPrompt?: string;
  /** Auto-send `initialPrompt` on open (the case renders a widget). Otherwise
   *  the prompt is just prefilled and the user sends it. */
  autoRun?: boolean;
  /** Connect the case's servers before chatting (the editor's Run uses this). */
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  /** Seeds model / system / temperature (+ message history) from the case. */
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
  /**
   * Bidirectional capture: each entry is one user turn of the live chat — its
   * prompt plus the tool calls the model actually made — surfaced so the editor
   * can reflect them back into the case spec (turns + expected tool calls).
   */
  onCaptureTurns?: (turns: CapturedTurn[]) => void;
  /** Tier-3 recorder bundle (armed widget records interaction steps). */
  recorder?: RecorderProps;
}

export type CapturedTurn = {
  prompt: string;
  expectedToolCalls: PromptTurnToolCall[];
};

/**
 * Fold the live chat's messages into per-user-turn capture: each `user` message
 * starts a turn (its text = prompt); the assistant tool calls that follow (until
 * the next user message) become that turn's expected tool calls, deduped by name.
 */
export function messagesToCapturedTurns(messages: UIMessage[]): CapturedTurn[] {
  const turns: CapturedTurn[] = [];
  let current: CapturedTurn | null = null;
  const seenForCurrent = new Set<string>();
  for (const message of messages) {
    if (message.role === "user") {
      const text = (message.parts ?? [])
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("")
        .trim();
      current = { prompt: text, expectedToolCalls: [] };
      seenForCurrent.clear();
      turns.push(current);
    } else if (message.role === "assistant" && current) {
      for (const part of message.parts ?? []) {
        if (!isToolPart(part) && !isDynamicTool(part)) continue;
        const info = getToolInfo(part as never);
        if (!info.toolName || seenForCurrent.has(info.toolName)) continue;
        seenForCurrent.add(info.toolName);
        current.expectedToolCalls.push({
          toolName: info.toolName,
          arguments: (info.input as Record<string, unknown>) ?? {},
        });
      }
    }
  }
  return turns;
}

export function EvalLiveChatPanel({
  projectId,
  caseServerNames,
  initialPrompt,
  autoRun = false,
  ensureServersReady,
  evalChatHandoff = null,
  onEvalChatHandoffConsumed,
  onCaptureTurns,
  recorder,
}: EvalLiveChatPanelProps) {
  const appState = useSharedAppState();

  const handleMessagesChange = useCallback(
    (messages: UIMessage[]) => {
      if (!onCaptureTurns) return;
      onCaptureTurns(messagesToCapturedTurns(messages));
    },
    [onCaptureTurns],
  );
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();

  const themeMode = usePreferencesStore((s) => s.themeMode);
  const hostStyle = usePreferencesStore((s) => s.hostStyle);
  const hostCapabilitiesOverride = usePreferencesStore(
    (s) => s.hostCapabilitiesOverride,
  );
  const chatUiOverride = usePreferencesStore((s) => s.chatUiOverride);

  // Known limitation: the editor doesn't have the resolved `activeHost`, so the
  // widget runtime scope is derived from preferences (mirrors how the old
  // TraceViewer preview installed its own scope). Threading the case's host so
  // caps match the suite Run exactly is a follow-up.
  const shellStyle = getChatboxShellStyle(hostStyle, themeMode);

  // Bind the surface to the case's servers (single-server mode falls back to the
  // first). Empty → PlaygroundMain still shows the composer (no server gate).
  const caseServers = caseServerNames ?? [];
  const primaryServerName = caseServers[0] ?? "";

  const state = usePlaygroundState({
    activeProjectId: projectId,
    serverName: primaryServerName,
    servers: appState.servers,
    isConvexAuthenticated,
    ensureServersReady,
    selectedServerNames: caseServers.length > 0 ? caseServers : undefined,
    // Onboarding/telemetry gating — the embedded panel is not the first-run
    // surface, so treat onboarding as already seen to keep it quiet.
    hasSeenFirstRunOnboarding: true,
    isProjectProvisioned: Boolean(projectId),
  });

  return (
    <PlaygroundStateProvider value={state}>
      <ActiveMcpProfileProvider value={undefined}>
        <ActiveHostCapsResolverScope activeHost={null} hostStyle={hostStyle}>
          <ChatboxHostStyleProvider value={hostStyle}>
            <ChatboxHostCapabilitiesOverrideProvider
              value={hostCapabilitiesOverride}
            >
              <ChatboxChatUiOverrideProvider value={chatUiOverride}>
                <ChatboxHostThemeProvider value={themeMode}>
                  <div
                    className={cn(
                      "chatbox-host-shell app-theme-scope flex h-full min-h-0 flex-1 flex-col overflow-hidden",
                      themeMode === "dark" && "dark",
                    )}
                    data-host-style={hostStyle}
                    style={shellStyle}
                  >
                    <PlaygroundMain
                      activeProjectId={projectId}
                      serverName={primaryServerName}
                      enableMultiModelChat={false}
                      isExecuting={state.isExecuting}
                      executingToolName={state.selectedTool}
                      invokingMessage={state.invokingMessage}
                      pendingExecution={state.pendingExecution}
                      onExecutionInjected={state.handleExecutionInjected}
                      onWidgetStateChange={(_toolCallId, widgetState) =>
                        state.setWidgetState(widgetState)
                      }
                      deviceType={state.deviceType}
                      onDeviceTypeChange={state.setDeviceType}
                      ensureServersReady={ensureServersReady}
                      initialInput={autoRun ? undefined : initialPrompt}
                      autoRunInput={autoRun ? initialPrompt : undefined}
                      blockSubmitUntilServerConnected
                      hideWelcomeHero
                      hideCenterHeaderChrome
                      hideInlineEdit
                      suppressHistoryConflictToast
                      onMessagesChange={handleMessagesChange}
                      recorder={recorder}
                      evalChatHandoff={evalChatHandoff}
                      onEvalChatHandoffConsumed={onEvalChatHandoffConsumed}
                    />
                  </div>
                </ChatboxHostThemeProvider>
              </ChatboxChatUiOverrideProvider>
            </ChatboxHostCapabilitiesOverrideProvider>
          </ChatboxHostStyleProvider>
        </ActiveHostCapsResolverScope>
      </ActiveMcpProfileProvider>
    </PlaygroundStateProvider>
  );
}
