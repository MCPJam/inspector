/**
 * Mid-session sign-in ("lazy authentication") lifecycle on direct surfaces:
 * the one place that decides what a sign-in challenge on a Tools, Playground,
 * Resources or Prompts call turns into, and that starts the sign-in.
 *
 * Three rules hold everywhere:
 *
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
  hasAuthChallengeAwaitingCallback,
  markAuthChallengeSignedIn,
  type ToolCallStepUpOperation,
} from "@/state/oauth-orchestrator";
import type { ServerWithName } from "@/state/app-types";
import {
  savePendingDirectScopeStepUpReplay,
  setPendingDirectScopeStepUpReplayCredentialBinding,
  setPendingDirectScopeStepUpReplayOAuthState,
  settlePendingDirectScopeStepUpReplayAfterCallback,
  type DirectScopeStepUpReplayDescriptor,
} from "@/lib/scope-step-up-replay";
import {
  setPendingChatScopeStepUpCredentialBinding,
  setPendingChatScopeStepUpOAuthState,
  settlePendingChatScopeStepUpAfterCallback,
} from "@/lib/scope-step-up-pending";
import {
  connectionIntentForBinding,
  type StepUpCredentialBinding,
} from "@/lib/scope-step-up-credential";
import {
  getScopeStepUpHostBridge,
  whenChatTurnsSettle,
} from "@/lib/scope-step-up";
import type {
  AuthChallengeNoticeEvent,
  AuthRequiredEvent,
} from "@/shared/auth-challenge";
import { SCOPE_STEP_UP_LIVE_TTL_MS } from "@/shared/scope-step-up";
import { track } from "@/lib/analytics";
import { authChallengeFromError } from "@/lib/apis/insufficient-scope";
import {
  createInspectorCommandClientError,
  type InspectorCommandClientError,
} from "@/lib/inspector-command-handlers";

export type AuthChallengeSurface =
  | "tools"
  | "playground"
  | "resources"
  | "prompts"
  | "chat"
  | "widget";

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
  /** The call declared `readOnlyHint: true`; otherwise it is not re-run on its own. */
  readOnly: boolean;
  /** Developer-only explanation of the host's decision. Text only. */
  explanation: string;
  expiresAt: number;
  /** The call to run again after sign-in (direct surfaces, `prompt` only). */
  replay?: DirectScopeStepUpReplayDescriptor;
  /** Hosted: the credential the failed call used. */
  connectionId?: string;
  /** Chat: called once the click is accepted, before the redirect. */
  onConnect?: () => void;
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
      reason:
        | "passthrough"
        | "blocked"
        | "permanent"
        | "dismissed";
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

const HOST_LABEL = "The selected host";

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

interface AuthChallengeCardState {
  cards: Record<string, AuthChallengeCard>;
  show: (card: AuthChallengeCard) => void;
  remove: (key: string) => void;
}

export const useAuthChallengeCardStore = create<AuthChallengeCardState>(
  (set) => ({
    cards: {},
    // The newest challenge for a server replaces the older card: only one
    // call can be waiting on a sign-in at a time.
    show: (card) =>
      set((state) => ({ cards: { ...state.cards, [card.key]: card } })),
    remove: (key) =>
      set((state) => {
        if (!state.cards[key]) return state;
        const { [key]: _removed, ...rest } = state.cards;
        return { cards: rest };
      }),
  }),
);

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

function cardKey(serverName: string, origin: string): string {
  return `${serverName}\u0000${origin}`;
}

// ---------------------------------------------------------------------------
// "Not now", remembered for the session
// ---------------------------------------------------------------------------

const DISMISSED_KEY = "mcp-auth-challenge-dismissed-v1";

function readDismissed(): string[] {
  try {
    const raw = sessionStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

export function isAuthChallengeDismissed(
  serverName: string,
  origin: string,
): boolean {
  return readDismissed().includes(cardKey(serverName, origin));
}

function rememberDismissed(serverName: string, origin: string): void {
  try {
    const entries = new Set(readDismissed());
    entries.add(cardKey(serverName, origin));
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...entries]));
  } catch {
    // Best-effort: the card may show again, never a redirect without a click.
  }
}

/** Forget "Not now" for a server: the user signed in some other way. */
export function clearAuthChallengeDismissed(serverName: string): void {
  try {
    const prefix = `${serverName}\u0000`;
    const entries = readDismissed().filter((entry) => !entry.startsWith(prefix));
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(entries));
  } catch {
    // Best-effort.
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
  onConnect?: () => void;
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

  const origin = mcpServerOrigin(server);
  const outcome = await applyToolCallAuthChallenge(server, signal, {
    operation: input.operation,
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
    key: cardKey(server.name, origin),
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
  };
  useAuthChallengeCardStore.getState().show(card);
  track("auth_challenge_card_shown", {
    location: input.surface,
    source: signal.source,
    action: decision.action,
  });
  return { kind: "card", card };
}

// ---------------------------------------------------------------------------
// Connect / Not now
// ---------------------------------------------------------------------------

export type AuthChallengeConnectResult =
  /** The click was not a trusted user gesture; nothing happened. */
  | { kind: "refused" }
  /** The card expired; the user signs in and runs the call again. */
  | { kind: "expired" }
  | { kind: "blocked"; hint: string }
  | { kind: "permanent" }
  | { kind: "started" }
  | { kind: "failed"; message: string };

/**
 * Start the sign-in for a card. Requires a trusted click (`event.isTrusted`):
 * only the user may send the browser to an authorization server.
 */
export async function connectAuthChallenge(
  card: AuthChallengeCard,
  server: ServerWithName | undefined,
  gesture: { isTrusted: boolean },
): Promise<AuthChallengeConnectResult> {
  if (!gesture.isTrusted || !server) return { kind: "refused" };
  const expired = card.expiresAt <= Date.now();

  track("auth_challenge_connect_clicked", {
    location: card.surface,
    source: card.signal.source,
    action: card.action,
  });

  // The binding is resolved before anything is saved: a hosted credential
  // that is not this user's is never replaced, and its call is not replayed.
  const bridge = getScopeStepUpHostBridge();
  let binding: StepUpCredentialBinding = card.connectionId
    ? { kind: "owned", credentialId: card.connectionId }
    : { kind: "none" };
  if (card.connectionId && bridge?.resolveCredentialBinding) {
    try {
      binding = await bridge.resolveCredentialBinding(
        server,
        card.connectionId,
      );
    } catch {
      binding = { kind: "shared", credentialId: card.connectionId };
    }
  }

  // Saved before the redirect, so the callback has something to settle. A
  // call that may change something asks "Run again?" instead of replaying.
  if (card.replay && card.action === "prompt" && !expired) {
    savePendingDirectScopeStepUpReplay({
      operation: {
        resourceUrl: String(
          (server.config as { url?: unknown })?.url ?? server.name,
        ),
        method: card.operation.method,
        operation: card.operation.operation,
      },
      descriptor: card.replay,
      reason: "authorization_required",
      requiresConfirmation: !card.readOnly,
    });
    setPendingDirectScopeStepUpReplayCredentialBinding(server.name, binding);
  }
  card.onConnect?.();
  // The chat marker (moved to `awaiting_oauth` by `onConnect`) records the
  // same binding, so its callback settles onto the right credential too.
  setPendingChatScopeStepUpCredentialBinding(server.name, binding);
  useAuthChallengeCardStore.getState().remove(card.key);
  // A chat redirect waits for the streaming turn to end and persist: leaving
  // mid-stream would lose the transcript holding the suspended tool call.
  if (card.surface === "chat") await whenChatTurnsSettle();

  const connectionIntent = connectionIntentForBinding(binding);
  try {
    const outcome = await applyToolCallAuthChallenge(server, card.signal, {
      operation: card.operation,
      confirmed: true,
      beforeRedirect: () => bridge?.prepareRedirect?.(server, connectionIntent),
      onAuthorizationRedirect: ({ state }) => {
        if (!state) return;
        setPendingDirectScopeStepUpReplayOAuthState(server.name, state);
        setPendingChatScopeStepUpOAuthState(server.name, state);
      },
    });
    if (outcome.kind === "blocked") {
      return { kind: "blocked", hint: outcome.hint };
    }
    if (outcome.kind === "permanent") return { kind: "permanent" };
    if (outcome.kind === "pendingConnect") return { kind: "refused" };
    const reauthorization = outcome.reauthorization;
    if (reauthorization.kind === "error") {
      track("auth_challenge_failed", {
        location: card.surface,
        source: card.signal.source,
        stage: "start",
      });
      return { kind: "failed", message: reauthorization.error };
    }
    return expired ? { kind: "expired" } : { kind: "started" };
  } catch (error) {
    track("auth_challenge_failed", {
      location: card.surface,
      source: card.signal.source,
      stage: "start",
    });
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
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

/** Drop a server's card without remembering anything (the call succeeded). */
export function clearAuthChallengeCards(serverName: string): void {
  const { cards, remove } = useAuthChallengeCardStore.getState();
  for (const card of Object.values(cards)) {
    if (card.serverName === serverName) remove(card.key);
  }
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

/**
 * Settle everything waiting on a completed OAuth callback for `serverName`:
 * the one-attempt ledger, the saved chat call and the saved direct call, each
 * bound to the callback's `state` and to the credential it produced. Returns
 * a message when the saved direct call was NOT replayed.
 */
export function settleSignInCallback(
  serverName: string,
  callback: { state?: string | null; credentialId?: string },
): string | undefined {
  // Bookkeeping never blocks the callback that completed the sign-in.
  let completed = 0;
  try {
    completed = markAuthChallengeSignedIn(serverName, callback.state);
  } catch {
    completed = 0;
  }
  if (completed > 0) {
    clearAuthChallengeDismissed(serverName);
    track("auth_challenge_completed", { location: "oauth_callback" });
  }
  settlePendingChatScopeStepUpAfterCallback(
    serverName,
    callback.credentialId,
    callback.state,
  );
  return settlePendingDirectScopeStepUpReplayAfterCallback(
    serverName,
    callback.credentialId,
    callback.state,
  );
}

/** A callback for `serverName` failed; record it if a sign-in was waiting. */
export function noteSignInCallbackFailed(serverName: string): void {
  try {
    if (!hasAuthChallengeAwaitingCallback(serverName)) return;
  } catch {
    return;
  }
  track("auth_challenge_failed", {
    location: "oauth_callback",
    stage: "callback",
  });
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** Developer-only notices for chat tool calls, keyed by tool call id. */
interface AuthChallengeNoticeState {
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
  onConnect?: () => void;
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
  const outcome = await applyToolCallAuthChallenge(server, signal, {
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
    key: cardKey(server.name, origin),
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
        source: signal.source === "tool_result_meta" ? "tool_result_meta" : "http_401",
        action: "passthrough",
        reason: "honored",
        ...(signal.effectiveAuth ? { effectiveAuth: signal.effectiveAuth } : {}),
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
