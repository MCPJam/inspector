import type { PendingWriteResult } from "@/lib/scope-step-up-pending";
import { create } from "zustand";
import {
  authChallengePolicyFrom,
  decideAuthChallengeAction,
  describeAuthChallengeDecision,
  type AuthChallengeSignal,
  type ToolSecuritySchemeResolution,
} from "@mcpjam/sdk/browser";
import {
  applyToolCallAuthChallenge,
  type AuthChallengeAttempt,
  type ToolCallStepUpOperation,
} from "@/state/oauth-orchestrator";
import type { ServerWithName } from "@/state/app-types";
import { type DirectScopeStepUpReplayDescriptor } from "@/lib/scope-step-up-replay";
import { SCOPE_STEP_UP_LIVE_TTL_MS } from "@/shared/scope-step-up";
import { track } from "@/lib/analytics";
import { connectAuthChallenge } from "./auth-challenge-connect";
import {
  isAuthChallengeDismissed,
  rememberDismissed,
} from "./auth-challenge-dismissal";


export {
  authorizationRequiredCommandError,
  authorizationRequiredCommandErrorFromSignal,
  clearChatAuthChallengeCard,
  presentChatAuthRequired,
  presentWidgetAuthChallenge,
  useAuthChallengeNoticeStore,
} from "./auth-challenge-chat";
export {
  connectAuthChallenge,
  noteSignInCallbackFailed,
  settleSignInCallback,
  type AuthChallengeConnectResult,
} from "./auth-challenge-connect";
export {
  clearAuthChallengeDismissed,
  isAuthChallengeDismissed,
} from "./auth-challenge-dismissal";
/**
 * Shared sign-in challenge lifecycle for Tools, Playground, Resources and Prompts.
 * - PRESENTING HAS NO SIDE EFFECTS. {@link presentAuthChallenge} decides
 *   between a Connect card, a notice and nothing. It writes no ledger, saves
 *   no call and never navigates.
 * - ONLY A TRUSTED CLICK SIGNS IN. {@link connectAuthChallenge} refuses a
 *   click that is not `isTrusted`, so a script, an inspector command, a WebMCP
 *   UI tool or a widget cannot start the redirect.
 * - THE SERVER'S STAMP DECIDES. Whether sign-in may start reads only the
 *   `effectiveAuth` the server stamped on the challenge, never a browser parse.
 *
 * A 403 `insufficient_scope` is not handled here: it keeps the step-up path
 * (`scope-step-up.ts`).
 */


export type AuthChallengeSurface =
  "tools" | "playground" | "resources" | "prompts" | "chat" | "widget";

export interface AuthChallengeCard {
  /** Coalescing key: one visible card per server and MCP origin. */
  key: string;
  serverName: string;
  /** The MCP server's origin. Never the authorization server's host. */
  serverOrigin: string;
  surface: AuthChallengeSurface;
  operation: ToolCallStepUpOperation;
  signal: AuthChallengeSignal;
  /** `notify` signs in without re-running the call. */
  action: "prompt" | "notify";
  /** Whether the call declared `readOnlyHint: true`. */
  readOnly: boolean;
  /** Developer-only explanation of the host's decision. Text only. */
  explanation: string;
  expiresAt: number;
  /** The call to run again after sign-in (direct surfaces, `prompt` only). */
  replay?: DirectScopeStepUpReplayDescriptor;
  /** Hosted: the credential the failed call used. */
  connectionId?: string;
  /** Chat: called once the click is accepted, before the redirect. */
  onConnect?: () => PendingWriteResult;
  continuationId?: string;
  attempt?: AuthChallengeAttempt;
  /** Chat: the suspended tool call this card belongs to. */
  toolCallId?: string;
  /** Chat: the server entry resolved when the part arrived. */
  server?: ServerWithName;
}

export type AuthChallengePresentation =
  /** Not a sign-in challenge this lifecycle owns (a 403 step-up, or none). */
  | { kind: "ignored" }
  | { kind: "card"; card: AuthChallengeCard }
  | {
      kind: "notice";
      reason: "passthrough" | "blocked" | "permanent" | "dismissed";
      /** The text to show beside the failed call. */
      message: string;
      /** Developer-only explanation, when there is one. */
      explanation?: string;
    };

// ---------------------------------------------------------------------------
// The host this surface emulates
// ---------------------------------------------------------------------------

/**
 * The active host's `mcpProfile`, registered by the app shell. Direct
 * surfaces and chat both read the single active host (the top-bar picker), so
 * they decide the same way. Absent means spec defaults.
 */
let activeHostProfile: () => unknown = () => undefined;

export function registerAuthChallengeHostProfile(
  read: () => unknown,
): () => void {
  activeHostProfile = read;
  return () => {
    if (activeHostProfile === read) activeHostProfile = () => undefined;
  };
}

export const HOST_LABEL = "The selected host";

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface AuthChallengeCardState {
  cards: Record<string, AuthChallengeCard>;
  show: (card: AuthChallengeCard) => void;
  remove: (key: string) => void;
}

export const useAuthChallengeCardStore = create<AuthChallengeCardState>((set) => ({
  cards: {},
  // The newest challenge for a server replaces the older card: only one
  // call can be waiting on a sign-in at a time.
  show: (card) =>
    set((state) => ({
      cards: {
        ...Object.fromEntries(
          Object.entries(state.cards).filter(
            ([, existing]) =>
              existing.surface === "chat" ||
              (existing.expiresAt > Date.now() &&
                !(
                  existing.surface === card.surface &&
                  existing.serverOrigin === card.serverOrigin &&
                  existing.serverName === card.serverName &&
                  existing.attempt?.projectId === card.attempt?.projectId
                )),
          ),
        ),
        [card.key]: card,
      },
    })),
  remove: (key) =>
    set((state) => {
      if (!state.cards[key]) return state;
      const { [key]: _removed, ...rest } = state.cards;
      return { cards: rest };
    }),
}));

/** The visible chat cards for these tool calls. */
export function useChatAuthChallengeCards(
  toolCallIds: readonly string[],
): AuthChallengeCard[] {
  const cards = useAuthChallengeCardStore((state) => state.cards);
  return Object.values(cards).filter(
    (card) =>
      card.surface === "chat" &&
      card.toolCallId !== undefined &&
      toolCallIds.includes(card.toolCallId),
  );
}

/** The visible cards for one surface (and optionally one server). */
export function useAuthChallengeCards(
  surface: AuthChallengeSurface,
  serverName?: string,
): AuthChallengeCard[] {
  const cards = useAuthChallengeCardStore((state) => state.cards);
  return Object.values(cards).filter(
    (card) =>
      card.surface === surface &&
      (serverName === undefined || card.serverName === serverName),
  );
}

export function mcpServerOrigin(server: ServerWithName | undefined): string {
  const url = (server?.config as { url?: unknown } | undefined)?.url;
  const raw = url instanceof URL ? url.toString() : url;
  if (typeof raw !== "string" || !raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Present
// ---------------------------------------------------------------------------

export const AUTH_CHALLENGE_DISMISSED_MESSAGE =
  "This server asked you to sign in. You chose Not now for this session; reconnect the server with OAuth to sign in.";

export const AUTH_CHALLENGE_PERMANENT_MESSAGE =
  "This server still asked for sign-in after you signed in, so the call was not retried. Your account may not have access to it.";

export function authChallengeErrorMessage(serverName: string): string {
  return `${serverName} needs you to sign in before this call can run.`;
}

/**
 * Decide what a sign-in challenge on one call becomes. No side effects beyond
 * showing a card: nothing is saved and nothing navigates.
 */
export function callAttempt(
  server: ServerWithName,
  surface: string,
  callId: string,
  projectId?: string | null,
  chatSessionId?: string,
): AuthChallengeAttempt {
  return {
    projectId:
      projectId ??
      window.location.pathname.match(/^\/p\/([^/]+)/)?.[1] ??
      "local",
    serverId: server.name,
    surface,
    callId,
    ...(chatSessionId ? { chatSessionId } : {}),
  };
}

export async function presentAuthChallenge(input: {
  server: ServerWithName | undefined;
  signal: AuthChallengeSignal | undefined;
  surface: AuthChallengeSurface;
  operation: ToolCallStepUpOperation;
  /** The tool's `readOnlyHint`; prompts and resource reads are reads. */
  readOnly: boolean;
  /** For a `_meta` challenge: the tool's schemes as the SERVER resolved them. */
  schemes?: ToolSecuritySchemeResolution;
  replay?: DirectScopeStepUpReplayDescriptor;
  connectionId?: string;
  onConnect?: () => PendingWriteResult;
  continuationId?: string;
}): Promise<AuthChallengePresentation> {
  const { server, signal } = input;
  if (!server || !signal || signal.source === "http_403_insufficient_scope") {
    return { kind: "ignored" };
  }

  const decision = decideAuthChallengeAction(
    signal,
    authChallengePolicyFrom(activeHostProfile()),
    input.schemes,
  );
  const explanation = describeAuthChallengeDecision(
    signal,
    decision,
    HOST_LABEL,
  );
  if (decision.action === "passthrough") {
    return {
      kind: "notice",
      reason: "passthrough",
      message: explanation,
      explanation,
    };
  }

  const attempt =
    input.replay?.authAttempt ??
    callAttempt(server, input.surface, crypto.randomUUID());
  if (input.replay) input.replay.authAttempt = attempt;
  const origin = mcpServerOrigin(server);
  const outcome = await applyToolCallAuthChallenge(server, signal, {
    operation: input.operation,
    attempt,
    confirmed: false,
  });
  if (outcome.kind === "blocked") {
    return {
      kind: "notice",
      reason: "blocked",
      message: outcome.hint,
      explanation,
    };
  }
  if (outcome.kind === "permanent") {
    return {
      kind: "notice",
      reason: "permanent",
      message: AUTH_CHALLENGE_PERMANENT_MESSAGE,
      explanation,
    };
  }
  if (isAuthChallengeDismissed(server.name, origin)) {
    return {
      kind: "notice",
      reason: "dismissed",
      message: AUTH_CHALLENGE_DISMISSED_MESSAGE,
      explanation,
    };
  }

  const card: AuthChallengeCard = {
    key: JSON.stringify(attempt),
    attempt,
    serverName: server.name,
    serverOrigin: origin,
    surface: input.surface,
    operation: input.operation,
    signal,
    action: decision.action,
    readOnly: input.readOnly,
    explanation,
    expiresAt: Date.now() + SCOPE_STEP_UP_LIVE_TTL_MS,
    ...(decision.action === "prompt" && input.replay
      ? { replay: input.replay }
      : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    ...(input.onConnect ? { onConnect: input.onConnect } : {}),
    ...(input.continuationId ? { continuationId: input.continuationId } : {}),
  };
  useAuthChallengeCardStore.getState().show(card);
  track("auth_challenge_card_shown", {
    location: input.surface,
    source: signal.source,
    action: decision.action,
  });
  return { kind: "card", card };
}

/** "Not now": hide the card and do not offer it again this session. */
export function dismissAuthChallenge(card: AuthChallengeCard): void {
  rememberDismissed(card.serverName, card.serverOrigin);
  useAuthChallengeCardStore.getState().remove(card.key);
  track("auth_challenge_dismissed", {
    location: card.surface,
    source: card.signal.source,
    action: card.action,
  });
}

/** Successful recovery only clears the card for that exact call. */
export function clearAuthChallengeCards(
  serverName: string,
  attempt?: AuthChallengeAttempt,
): void {
  if (!attempt) return;
  const { cards, remove } = useAuthChallengeCardStore.getState();
  for (const card of Object.values(cards)) {
    if (
      card.serverName === serverName &&
      card.attempt &&
      card.attempt.projectId === attempt.projectId &&
      card.attempt.serverId === attempt.serverId &&
      card.attempt.surface === attempt.surface &&
      card.attempt.callId === attempt.callId &&
      card.attempt.chatSessionId === attempt.chatSessionId
    )
      remove(card.key);
  }
}
