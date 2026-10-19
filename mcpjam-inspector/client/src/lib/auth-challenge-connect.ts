import { track } from "@/lib/analytics";
import {
  CHAT_AUTH_RECOVERY_MESSAGE,
  recordChatAuthRecoveryFailure,
} from "@/lib/chat-auth-recovery";
import { authorizationFlowDigest } from "@/lib/oauth/flow-digest";
import {
  getScopeStepUpHostBridge,
  whenChatTurnsSettle,
} from "@/lib/scope-step-up";
import {
  connectionIntentForBinding,
  type StepUpCredentialBinding,
} from "@/lib/scope-step-up-credential";
import {
  setPendingChatScopeStepUpCredentialBinding,
  setPendingChatScopeStepUpFlowDigest,
  settlePendingChatScopeStepUpAfterCallback,
} from "@/lib/scope-step-up-pending";
import {
  clearPendingDirectScopeStepUpReplay,
  savePendingDirectScopeStepUpReplay,
  setPendingDirectScopeStepUpReplayCredentialBinding,
  setPendingDirectScopeStepUpReplayFlowDigest,
  settlePendingDirectScopeStepUpReplayAfterCallback,
  type PendingDirectScopeStepUpReplay,
} from "@/lib/scope-step-up-replay";
import type { ServerWithName } from "@/state/app-types";
import {
  applyToolCallAuthChallenge,
  hasAuthChallengeAwaitingCallback,
  markAuthChallengeSignedIn,
} from "@/state/oauth-orchestrator";
import {
  AuthChallengeCard,
  clearAuthChallengeDismissed,
  useAuthChallengeCardStore,
} from "./auth-challenge-lifecycle";

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
  | { kind: "waiting"; message: string }
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

  if (card.onConnect) {
    const prepared = card.onConnect();
    if (!prepared.ok && prepared.reason === "loading")
      return {
        kind: "waiting",
        message:
          "Chats are still restoring. Please try Connect again in a moment.",
      };
    if (!prepared.ok)
      return {
        kind: "failed",
        message:
          prepared.reason === "storage"
            ? "MCPJam couldn’t save this call for sign-in. Please try again."
            : CHAT_AUTH_RECOVERY_MESSAGE,
      };
  }

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

  // Saved before the redirect, so the callback has something to settle.
  const savedReplay = Boolean(
    card.replay && card.action === "prompt" && !expired,
  );
  // A sign-in that never redirected has no callback to settle the saved call,
  // which would otherwise wait for an unrelated later sign-in.
  let pendingReplay: PendingDirectScopeStepUpReplay | undefined;
  const dropSavedReplay = () => {
    if (pendingReplay) clearPendingDirectScopeStepUpReplay(pendingReplay);
  };
  if (savedReplay && card.replay) {
    try {
      pendingReplay = savePendingDirectScopeStepUpReplay({
        operation: {
          resourceUrl: String(
            (server.config as { url?: unknown })?.url ?? server.name,
          ),
          method: card.operation.method,
          operation: card.operation.operation,
        },
        descriptor: card.replay,
        reason: "authorization_required",
      });
      setPendingDirectScopeStepUpReplayCredentialBinding(
        server.name,
        binding,
        pendingReplay,
      );
    } catch {
      dropSavedReplay();
      recordChatAuthRecoveryFailure("save_failed", {
        toolCallId: card.attempt?.callId,
        projectId: card.attempt?.projectId,
        serverName: server.name,
        storageOutcome: "failed",
      });
      return {
        kind: "failed",
        message:
          "MCPJam couldn’t save this call for sign-in. Please try again.",
      };
    }
  }
  // The chat marker (moved to `awaiting_oauth` by `onConnect`) records the
  // same binding, so its callback settles onto the right credential too.
  const bound =
    !card.continuationId ||
    setPendingChatScopeStepUpCredentialBinding(
      server.name,
      binding,
      card.continuationId,
    );
  if (card.continuationId && !bound)
    return { kind: "failed", message: CHAT_AUTH_RECOVERY_MESSAGE };
  // A chat redirect waits for the streaming turn to end and persist: leaving
  // mid-stream would lose the transcript holding the suspended tool call.
  if (card.surface === "chat") await whenChatTurnsSettle();

  const connectionIntent = connectionIntentForBinding(binding);
  try {
    // A hosted grant has no tokens in the browser. The failed call's own
    // credential proves one exists; otherwise the shell is asked.
    const existingGrant =
      binding.kind !== "none" ||
      (await bridge?.hasExistingGrant?.(server)) === true;
    const outcome = await applyToolCallAuthChallenge(server, card.signal, {
      operation: card.operation,
      attempt: card.attempt,
      confirmed: true,
      existingGrant,
      beforeRedirect: () =>
        card.continuationId
          ? bridge?.prepareRedirect?.(
              server,
              connectionIntent,
              card.continuationId,
            )
          : bridge?.prepareRedirect?.(server, connectionIntent),
      onAuthorizationFlow: ({ digest }) => {
        if (savedReplay)
          setPendingDirectScopeStepUpReplayFlowDigest(
            server.name,
            digest,
            pendingReplay,
          );
        const saved =
          !card.continuationId ||
          setPendingChatScopeStepUpFlowDigest(
            server.name,
            digest,
            card.continuationId,
          );
        if (card.continuationId && !saved)
          throw new Error(CHAT_AUTH_RECOVERY_MESSAGE);
      },
    });
    if (
      outcome.kind !== "started" ||
      outcome.reauthorization.kind !== "redirect"
    ) {
      dropSavedReplay();
    }
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
    if (reauthorization.kind !== "redirect") return { kind: "refused" };
    useAuthChallengeCardStore.getState().remove(card.key);
    return expired ? { kind: "expired" } : { kind: "started" };
  } catch (error) {
    dropSavedReplay();
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

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

/**
 * Settle everything waiting on a completed OAuth callback for `serverName`:
 * the one-attempt ledger, the saved chat call and the saved direct call, each
 * bound to the callback's `state` and to the credential it produced. Returns
 * a message when the saved direct call was NOT replayed.
 */
export async function settleSignInCallback(
  serverName: string,
  callback: {
    state?: string | null;
    credentialId?: string;
    continuationId?: string;
  },
): Promise<string | undefined> {
  // Compared by digest: the saved calls recorded the flow's digest, never its
  // `state`.
  const digest = await authorizationFlowDigest(callback.state);
  // Bookkeeping never blocks the callback that completed the sign-in.
  let completed = 0;
  try {
    completed = markAuthChallengeSignedIn(serverName, digest);
  } catch {
    completed = 0;
  }
  if (completed > 0) {
    clearAuthChallengeDismissed(serverName);
    track("auth_challenge_completed", { location: "oauth_callback" });
  }
  const chatSettlement = settlePendingChatScopeStepUpAfterCallback(
    serverName,
    callback.credentialId,
    digest,
    callback.continuationId,
  );
  let directMessage: string | undefined;
  try {
    directMessage = settlePendingDirectScopeStepUpReplayAfterCallback(
      serverName,
      callback.credentialId,
      digest,
    );
  } catch (error) {
    // A storage failure prevents replay, but does not undo the completed sign-in.
    console.debug("Could not save the signed-in call for replay", error);
    directMessage = CHAT_AUTH_RECOVERY_MESSAGE;
  }
  return chatSettlement.kind === "failed"
    ? chatSettlement.message
    : directMessage;
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
