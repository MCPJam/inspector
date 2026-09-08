import { stopAgentChat } from "./agent-chat-instances";
import { dismissAskUserQuestions } from "@/lib/webmcp/ask-user-store";
import { create } from "zustand";
import { generateId } from "ai";
import {
  evalAgentScopeSchema,
  EVAL_AGENT_TOOL_NAMES,
  type EvalAgentScope,
} from "@/shared/eval-agent-scope";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";

// v1 conversations could contain multiple suites/cases. Never resume them as
// isolated conversations after the boundary fix.
const KEY = "mcpjam:eval-agent-scopes:v2";
function load(): Record<string, EvalAgentScope> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return Object.fromEntries(
      Object.entries(raw).flatMap(([id, value]) => {
        const parsed = evalAgentScopeSchema.safeParse(value);
        return parsed.success ? [[id, parsed.data]] : [];
      }),
    );
  } catch {
    return {};
  }
}
export const useEvalAgentScopes = create<{
  scopes: Record<string, EvalAgentScope>;
  set: (sessionId: string, scope: EvalAgentScope) => void;
}>((set, get) => ({
  scopes: load(),
  set: (sessionId, scope) => {
    const scopes = { ...get().scopes, [sessionId]: scope };
    // A failed persistence must not silently turn a resumed eval session into general chat.
    try {
      localStorage.setItem(KEY, JSON.stringify(scopes));
    } catch {
      /* eval- ids fail closed on reload */
    }
    set({ scopes });
  },
}));
export function readEvalScope(sessionId: string): EvalAgentScope | undefined {
  const scope = useEvalAgentScopes.getState().scopes[sessionId];
  if (!scope && sessionId.startsWith("eval-"))
    throw new Error(
      "Eval context is unavailable. Reopen Ask MCPJam from the case or suite.",
    );
  return scope;
}
const turns = new Map<string, EvalAgentScope | undefined>();
export function pinEvalTurn(sessionId: string) {
  turns.set(sessionId, readEvalScope(sessionId));
}
export function evalTurnScope(sessionId: string) {
  return turns.has(sessionId) ? turns.get(sessionId) : readEvalScope(sessionId);
}
export function assertEvalToolAllowed(
  sessionId: string | undefined,
  toolName: string,
) {
  if (!sessionId) return;
  const current = readEvalScope(sessionId);
  const pinned = evalTurnScope(sessionId);
  if (current?.id !== pinned?.id)
    throw new Error(
      "Eval context changed during this turn. Submit a new request for the current case.",
    );
  if (pinned && !EVAL_AGENT_TOOL_NAMES.has(toolName))
    throw new Error(
      `Tool ${toolName} is unavailable in eval scope. This conversation only supports eval work.`,
    );
}
type EvalChatTarget = Omit<EvalAgentScope, "kind" | "version" | "id">;
function sameTarget(a: EvalChatTarget, b: EvalChatTarget) {
  return (
    a.projectId === b.projectId &&
    a.suiteId === b.suiteId &&
    a.caseId === b.caseId
  );
}

export function openEvalChat(
  input: EvalChatTarget,
  options: { fresh?: boolean } = {},
): string {
  const panel = useAgentPanelStore.getState();
  const scopes = useEvalAgentScopes.getState().scopes;
  const previous = panel.activeSessionId
    ? scopes[panel.activeSessionId]
    : undefined;
  // Most recently created conversation for this exact target, including an
  // explicit New chat. Titles are display metadata, never conversation keys.
  const existing = options.fresh
    ? undefined
    : Object.entries(scopes)
        .reverse()
        .find(([, scope]) => sameTarget(scope, input));
  const sessionId = existing?.[0] ?? `eval-${generateId()}`;
  if (previous && panel.activeSessionId !== sessionId)
    invalidateEvalTurn(panel.activeSessionId!);
  const scope: EvalAgentScope = {
    ...input,
    kind: "evals",
    version: 1,
    id: existing?.[1].id ?? generateId(),
  };
  useEvalAgentScopes.getState().set(sessionId, scope);
  panel.setActiveSession(sessionId, input.projectId);
  panel.setOpen(true);
  return sessionId;
}
export function newEvalChat(scope: EvalAgentScope): string {
  return openEvalChat(scope, { fresh: true });
}

/** Follow explicit page navigation without opening a closed panel or replacing general chat. */
export function syncEvalChatContext(input: EvalChatTarget) {
  const panel = useAgentPanelStore.getState();
  if (
    !panel.activeSessionId ||
    (!useEvalAgentScopes.getState().scopes[panel.activeSessionId] &&
      !panel.activeSessionId.startsWith("eval-"))
  )
    return;
  const wasOpen = panel.isOpen;
  openEvalChat(input);
  panel.setOpen(wasOpen);
}

/** Saving the same logical draft is a continuation, not a different case. */
export function promoteEvalDraftChat(input: EvalChatTarget, savedCaseId: string) {
  const panel = useAgentPanelStore.getState();
  const sessionId = panel.activeSessionId;
  const scope = sessionId ? useEvalAgentScopes.getState().scopes[sessionId] : undefined;
  if (!sessionId || !scope || !sameTarget(scope, input) || !scope.caseId?.startsWith("draft:")) return;
  invalidateEvalTurn(sessionId);
  useEvalAgentScopes.getState().set(sessionId, { ...scope, caseId: savedCaseId, id: generateId() });
}

/** Leaving a task invalidates its queued calls without widening its capability set. */
export function invalidateEvalTurn(sessionId: string) {
  const scope = readEvalScope(sessionId);
  stopAgentChat(sessionId);
  dismissAskUserQuestions("new_message", { scope: sessionId });
  const queued = useEvalPromptQueue.getState().pending[sessionId];
  if (queued) useEvalPromptQueue.getState().consume(sessionId, queued.id);
  if (scope)
    useEvalAgentScopes
      .getState()
      .set(sessionId, { ...scope, id: generateId() });
}

/** Observable handoff works for both a new thread and an already-mounted chat. */
export const useEvalPromptQueue = create<{
  pending: Record<string, { id: string; text: string }>;
  enqueue: (sessionId: string, text: string) => void;
  consume: (sessionId: string, id: string) => void;
}>((set) => ({
  pending: {},
  enqueue: (sessionId, text) =>
    set((state) => ({
      pending: { ...state.pending, [sessionId]: { id: generateId(), text } },
    })),
  consume: (sessionId, id) =>
    set((state) => {
      if (state.pending[sessionId]?.id !== id) return state;
      const pending = { ...state.pending };
      delete pending[sessionId];
      return { pending };
    }),
}));
