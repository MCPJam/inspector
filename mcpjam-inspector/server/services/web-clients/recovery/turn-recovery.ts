/**
 * Recovery around one web client turn. A browser that failed is reconnected
 * and the turn tried again; a sign-in page pauses the run on the account's
 * reconnect request until a person hands the account back. Before anything
 * is sent again the ledger is read: a call the server answered is not sent
 * again, and one it never answered stops the step, since it may have run.
 *
 * The turn is tried again under the same turn key, so the send journal keeps
 * the prompt to one send in this process, and after a restart the ledger
 * check marks it sent before the turn can send it twice.
 */
import { webClientVendorForRuntime } from "../../../../shared/web-clients.js";
import type { SendJournal } from "../../../utils/harness/real-ui/drive-turn.js";
import type {
  NeedsSignInReason,
  RealUiFailure,
  RealUiStep,
} from "../../../utils/harness/real-ui/page-module.js";
import { logger } from "../../../utils/logger.js";
import {
  runWebClientTurn,
  type WebClientTurnInput,
  type WebClientTurnResult,
} from "../run-web-client-turn.js";
import type { WebClientEnvironment } from "../web-client-environment.js";
import { accountBrowserOver } from "./account-browser.js";
import type { PendingStep, WebReconnectBackend } from "./backend.js";
import type { WebActor } from "./convex-backend.js";
import {
  createWebRecoveryCoordinator,
  type RunFailure,
  type WebRecoveryDeps,
} from "./coordinator.js";
import { resumeWebRun, waitForResume } from "./paused-runs.js";
import type { LedgerReader } from "./reconcile.js";

/** Why a run stopped where recovery could not carry it on by itself. */
export type WebRunStop =
  | {
      kind: "paused_for_person";
      requestId: string;
      reason: NeedsSignInReason;
      /** The step the run resumes from. */
      step: RealUiStep;
      /** What the page asked for. */
      message: string;
    }
  | {
      /** These calls reached the server with no answer: they may have run. */
      kind: "ambiguous_execution";
      calls: Array<{ toolName: string; toolUseId?: string }>;
    };

/** A turn's result, with why recovery stopped it when it did. */
export type RecoverableWebTurnResult = WebClientTurnResult & {
  stop?: WebRunStop;
};

export type WebRecoverySetup = {
  /** The reconnect backend, acting for the run's person. */
  backendFor(run: { projectId: string; runId: string }): WebReconnectBackend;
  ledger: LedgerReader;
  signInMethodFor?: WebRecoveryDeps["signInMethodFor"];
  /** How long a paused turn waits for the handback. */
  maxPauseMs?: number;
  /** How often a paused turn reads its request, for a handback elsewhere. */
  pollMs?: number;
  /**
   * The environment whose `openBrowser` gives the browser a person signed the
   * account in with, for a handback. Hosted, their sign-in browser.
   */
  handbackEnvironment?(handback: {
    actor: WebActor;
    projectId: string;
  }): Promise<WebClientEnvironment | undefined>;
};

let configured: WebRecoverySetup | undefined;

/** Set at startup where web accounts are kept, or by a test. */
export function setWebRecovery(setup: WebRecoverySetup | undefined): void {
  configured = setup;
}

export function webRecovery(): WebRecoverySetup | undefined {
  return configured;
}

const MAX_PAUSE_MS = 15 * 60_000;
const POLL_MS = 5_000;
/** Tries of one turn in all: the first, and at most 2 retries. */
const MAX_ATTEMPTS = 3;
/** Steps after which the prompt may already be in the vendor's chat. */
const SENT_STEPS: ReadonlySet<string> = new Set([
  "send",
  "reply",
  "read_conversation",
]);

/** The page's failure as recovery sees it; undefined when the run stops as before. */
export function runFailureOf(failure: RealUiFailure): RunFailure | undefined {
  switch (failure.kind) {
    case "needs_sign_in":
      return { kind: "needs_sign_in", reason: failure.reason };
    // The browser failed, not the account: reconnect it and read the ledger.
    case "driver":
      return { kind: "browser_crashed" };
    case "reply_timeout":
      return { kind: "stream_dropped" };
    // A changed page, a broken connector, a plan wall or a send that may have
    // happened are not fixed by reconnecting.
    default:
      return undefined;
  }
}

/**
 * Records the prompt as possibly sent by the attempt that began at `at`, so
 * the turn looks for its chat first. The send came after `at`, and the turn
 * takes only a chat created since then.
 */
async function keepSendRecord(journal: SendJournal, turnKey: string, at: string) {
  // A record already there stays, since it may name the chat the send made.
  await journal.claim(turnKey, { state: "sending", at });
}

export async function runRecoverableWebTurn(
  input: WebClientTurnInput,
  setup: WebRecoverySetup | undefined,
  onPaused?: (
    paused: Extract<WebRunStop, { kind: "paused_for_person" }>,
  ) => void,
): Promise<RecoverableWebTurnResult> {
  const vendor = webClientVendorForRuntime(input.runtimeId);
  if (!setup || !vendor) return runWebClientTurn(input);
  const { projectId, runId, environment } = input;
  const backend = setup.backendFor({ projectId, runId });
  const coordinator = createWebRecoveryCoordinator({
    backend,
    ledger: setup.ledger,
    resumeRun: resumeWebRun,
    ...(setup.signInMethodFor
      ? { signInMethodFor: setup.signInMethodFor }
      : {}),
  });
  const handleFailure = async (
    failure: RunFailure,
    pendingStep: PendingStep,
  ) => {
    const account = await environment.resolveAccount({ projectId, vendor });
    const browser = accountBrowserOver(environment, { ...account, vendor });
    // The profile this run restored: signed in again since, it reloads instead.
    const restored = environment.restoredProfileVersion?.(account.webAccountId);
    try {
      return await coordinator.handleStepFailure({
        failure,
        projectId,
        webAccountId: account.webAccountId,
        runId,
        pendingStep,
        browser,
        ...(restored !== undefined ? { restoredProfileVersion: restored } : {}),
      });
    } finally {
      // A browser that won't close must not fail the recovery it served.
      await browser.close().catch((error: unknown) => {
        logger.warn("[web-recovery] The account's browser did not close", {
          runId,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  };
  /**
   * The step's calls the server never answered, as the stop that reports
   * them: they may have run, so no one should be asked to send them again.
   */
  const ledgerCheck = async (step: PendingStep) => {
    const verdict = await coordinator.reconcileBeforeResend({ runId, step });
    if (verdict.status !== "ambiguous_execution") return { verdict };
    const calls = verdict.calls.map(({ toolName, toolUseId }) => ({
      toolName,
      ...(toolUseId ? { toolUseId } : {}),
    }));
    return {
      verdict,
      ambiguous: { kind: "ambiguous_execution", calls } as const,
    };
  };
  let attempt = input;
  // A retry keeps the turn and its earlier calls, so the turn's trace starts
  // with its first try.
  let firstStartedAt: number | undefined;
  for (let tried = 1; ; tried += 1) {
    const tryResult = await runWebClientTurn(attempt);
    firstStartedAt ??= tryResult.startedAt;
    const result = { ...tryResult, startedAt: firstStartedAt };
    if (result.ok) return result;
    const failure = runFailureOf(result.failure);
    if (!failure) return result;
    // The last try is not sent again, but its sign-out still opens the
    // account's sign-in request, and its calls are still read from the ledger.
    const last = tried >= MAX_ATTEMPTS;
    const step: PendingStep = result.pendingStep ?? {
      stepId: result.failure.step,
      startedAt: new Date(tryResult.startedAt).toISOString(),
      turnId: result.turnId,
    };
    const outcome = await handleFailure(failure, step);
    if (
      outcome.status === "paused" &&
      result.failure.kind === "needs_sign_in"
    ) {
      const paused = {
        kind: "paused_for_person",
        requestId: outcome.requestId,
        reason: result.failure.reason,
        step: result.failure.step,
        message: result.failure.message,
      } as const;
      // A paused turn still reports a call that may have run.
      const pausedStop = async () => ({
        ...result,
        stop: (await ledgerCheck(step)).ambiguous ?? paused,
      });
      // No try is left to carry the turn on after a handback.
      if (last) return pausedStop();
      onPaused?.(paused);
      const waitingOn = { requestId: outcome.requestId, runId };
      const resumed = await waitForResume(waitingOn, step, {
        ...(input.signal ? { signal: input.signal } : {}),
        timeoutMs: setup.maxPauseMs ?? MAX_PAUSE_MS,
        pollMs: setup.pollMs ?? POLL_MS,
        requestStatus: async () =>
          (await backend.listWebReconnectRequests({ projectId })).find(
            (request) => request.requestId === outcome.requestId,
          )?.status,
      });
      if (!resumed) return pausedStop();
    }
    const { verdict, ambiguous } = await ledgerCheck(step);
    if (ambiguous) return { ...result, stop: ambiguous };
    if (last) return result;
    if (verdict.status === "reconciled" || SENT_STEPS.has(step.stepId)) {
      await keepSendRecord(
        environment.journal,
        result.turnId,
        new Date(tryResult.startedAt).toISOString(),
      );
    }
    attempt = { ...input, turnId: result.turnId };
  }
}

/** What a person reads when a call may have run and was not sent again. */
export function ambiguousExecutionMessage(
  name: string,
  stop: Extract<WebRunStop, { kind: "ambiguous_execution" }>,
): string {
  const tools = [...new Set(stop.calls.map((call) => call.toolName))].join(
    ", ",
  );
  return `A call to ${tools} reached the server, but no answer came back, so it may have run. MCPJam didn't send it again. Open the chat in ${name} to check before you send again.`;
}
