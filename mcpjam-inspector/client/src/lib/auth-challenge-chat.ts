import { track } from "@/lib/analytics";
import { authChallengeFromError } from "@/lib/apis/insufficient-scope";
import {
  createInspectorCommandClientError,
  type InspectorCommandClientError,
} from "@/lib/inspector-command-handlers";
import type { PendingWriteResult } from "@/lib/scope-step-up-pending";
import type {
  AuthChallengeNoticeEvent,
  AuthRequiredEvent,
} from "@/shared/auth-challenge";
import type { ServerWithName } from "@/state/app-types";
import { applyToolCallAuthChallenge } from "@/state/oauth-orchestrator";
import {
  type AuthChallengeSignal,
  type ToolSecuritySchemeResolution,
} from "@mcpjam/sdk/browser";
import { create } from "zustand";
import {
  AUTH_CHALLENGE_DISMISSED_MESSAGE,
  AUTH_CHALLENGE_PERMANENT_MESSAGE,
  AuthChallengeCard,
  AuthChallengePresentation,
  callAttempt,
  HOST_LABEL,
  isAuthChallengeDismissed,
  mcpServerOrigin,
  presentAuthChallenge,
  useAuthChallengeCardStore,
} from "./auth-challenge-lifecycle";

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Developer-only notices for chat tool calls, keyed by tool call id. */
export interface AuthChallengeNoticeState {
  notices: Record<string, AuthChallengeNoticeEvent>;
  add: (event: AuthChallengeNoticeEvent) => void;
}

export const useAuthChallengeNoticeStore = create<AuthChallengeNoticeState>(
  (set) => ({
    notices: {},
    add: (event) =>
      set((state) => ({
        notices: { ...state.notices, [event.toolCallId]: event },
      })),
  }),
);

/**
 * Show the Connect card for a chat `data-auth-required` part. The SERVER
 * already applied the host's policy and the auth-method gate; this checks the
 * gate again (defense in depth), the repeat-after-sign-in ledger and "Not
 * now", and never starts anything.
 */
export async function presentChatAuthRequired(input: {
  server: ServerWithName | undefined;
  event: AuthRequiredEvent;
  projectId?: string | null;
  chatSessionId?: string;
  onConnect?: () => PendingWriteResult;
  continuationId?: string;
}): Promise<AuthChallengePresentation> {
  const { server, event } = input;
  if (!server) return { kind: "ignored" };
  const signal: AuthChallengeSignal = {
    source: event.source,
    ...(event.requiredScope ? { requiredScope: event.requiredScope } : {}),
    ...(event.resourceMetadataUrl
      ? { resourceMetadataUrl: event.resourceMetadataUrl }
      : {}),
    ...(event.errorDescription
      ? { errorDescription: event.errorDescription }
      : {}),
    effectiveAuth: event.effectiveAuth,
    facets: {
      challengeHeader: "none",
      hasResourceMetadata: Boolean(event.resourceMetadataUrl),
      hasScope: Boolean(event.requiredScope),
      hasErrorParams: false,
    },
  };
  const attempt = callAttempt(
    server,
    "chat",
    event.continuationId ?? event.toolCallId,
    input.projectId,
    input.chatSessionId,
  );
  const outcome = await applyToolCallAuthChallenge(server, signal, {
    attempt,
    operation: event.operation,
    confirmed: false,
  });
  if (outcome.kind === "blocked") {
    return { kind: "notice", reason: "blocked", message: outcome.hint };
  }
  if (outcome.kind === "permanent") {
    return {
      kind: "notice",
      reason: "permanent",
      message: AUTH_CHALLENGE_PERMANENT_MESSAGE,
    };
  }
  const origin = mcpServerOrigin(server);
  if (isAuthChallengeDismissed(server.name, origin)) {
    return {
      kind: "notice",
      reason: "dismissed",
      message: AUTH_CHALLENGE_DISMISSED_MESSAGE,
    };
  }
  const card: AuthChallengeCard = {
    key: JSON.stringify(attempt),
    attempt,
    serverName: server.name,
    serverOrigin: origin,
    surface: "chat",
    operation: event.operation,
    signal,
    action: event.continuationId ? event.action : "notify",
    readOnly: event.readOnly,
    explanation:
      event.action === "prompt" && event.continuationId
        ? `${HOST_LABEL} shows a sign-in prompt for this challenge and retries the call after sign-in.`
        : `${HOST_LABEL} tells the user to sign in, but does not retry the call.`,
    expiresAt: event.expiresAt,
    toolCallId: event.toolCallId,
    server,
    ...(event.connectionId ? { connectionId: event.connectionId } : {}),
    ...(input.onConnect ? { onConnect: input.onConnect } : {}),
    ...(input.continuationId ? { continuationId: input.continuationId } : {}),
  };
  useAuthChallengeCardStore.getState().show(card);
  track("auth_challenge_card_shown", {
    location: "chat",
    source: signal.source,
    action: card.action,
  });
  return { kind: "card", card };
}

/** Drop the chat card for one tool call (the call was cancelled or ran). */
export function clearChatAuthChallengeCard(toolCallId: string): void {
  const { cards, remove } = useAuthChallengeCardStore.getState();
  for (const card of Object.values(cards)) {
    if (card.toolCallId === toolCallId) remove(card.key);
  }
}

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------

/**
 * A widget's own `callTool` hit a sign-in challenge. The Connect card shows
 * in host chrome under the widget, never inside the iframe, and the call is
 * not replayed into the iframe: the widget already received its error (or
 * the challenged result) and can call again after sign-in.
 */
export function presentWidgetAuthChallenge(input: {
  server: ServerWithName | undefined;
  signal: AuthChallengeSignal | undefined;
  toolName: string;
  /** The tool call whose widget made the call; the card renders under it. */
  toolCallId?: string;
  schemes?: ToolSecuritySchemeResolution;
}): void {
  const { server, signal, toolCallId } = input;
  if (!server || !signal || !toolCallId) return;
  void presentAuthChallenge({
    server,
    signal,
    surface: "chat",
    operation: { method: "tools/call", operation: input.toolName },
    readOnly: false,
    ...(input.schemes ? { schemes: input.schemes } : {}),
  }).then((presentation) => {
    if (presentation.kind === "notice") {
      useAuthChallengeNoticeStore.getState().add({
        version: 1,
        kind: "auth_challenge_notice",
        serverId: server.name,
        serverName: server.name,
        toolCallId,
        operation: { method: "tools/call", operation: input.toolName },
        source:
          signal.source === "tool_result_meta"
            ? "tool_result_meta"
            : "http_401",
        action: "passthrough",
        reason: "honored",
        ...(signal.effectiveAuth
          ? { effectiveAuth: signal.effectiveAuth }
          : {}),
        explanation: presentation.message,
      });
      return;
    }
    if (presentation.kind !== "card") return;
    // Under the widget's own tool call, without a replay.
    useAuthChallengeCardStore.getState().show({
      ...presentation.card,
      action: "notify",
      toolCallId,
      server,
    });
  });
}

// ---------------------------------------------------------------------------
// Machine-driven calls
// ---------------------------------------------------------------------------

/**
 * The typed error an inspector command or agent-driven call returns when the
 * server asked the user to sign in. Commands never sign in and never show a
 * Connect card: only the user, on screen, can start a sign-in.
 */
export function authorizationRequiredCommandError(
  error: unknown,
  serverName: string,
): InspectorCommandClientError | undefined {
  return authorizationRequiredCommandErrorFromSignal(
    authChallengeFromError(error),
    serverName,
  );
}

/** {@link authorizationRequiredCommandError} for a challenge already in hand. */
export function authorizationRequiredCommandErrorFromSignal(
  signal: AuthChallengeSignal | undefined,
  serverName: string,
): InspectorCommandClientError | undefined {
  if (!signal || signal.source === "http_403_insufficient_scope") {
    return undefined;
  }
  return createInspectorCommandClientError(
    "authorization_required",
    `${serverName} asked the user to sign in before this call can run. Commands do not sign in: ask the user to run it on screen in MCPJam and click Connect.`,
    {
      source: signal.source,
      ...(signal.requiredScope ? { requiredScope: signal.requiredScope } : {}),
    },
  );
}
