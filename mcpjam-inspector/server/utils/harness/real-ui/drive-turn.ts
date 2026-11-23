/**
 * One turn on a vendor's website, in the same order for every site: check the
 * account, make sure the connector is there, open a new chat, enable the
 * connector, send the prompt exactly once, answer the app's own approval
 * prompts until the reply has finished, then read the saved conversation.
 *
 * EXACTLY ONCE. The journal records the send before the click. A run that
 * restarts and finds that record looks for a chat created since then that
 * holds the prompt, records it as sent and continues there; when no chat
 * holds it, the send may still have happened, so the turn stops as
 * `send_ambiguous` rather than send again. A send that fails after the
 * record stops the same way.
 */
import { PageDriverError, type PageDriver } from "./page-driver.js";
import {
  RealUiError,
  needsSignIn,
  type PendingStep,
  type RealUiPageModule,
  type RealUiStep,
  type SavedConversation,
  type WebAccountIdentity,
} from "./page-module.js";

/** `at` is when the send began, just before the click, in both states. */
export type SendJournalEntry =
  | { state: "sending"; at: string }
  | { state: "sent"; at: string; conversationUrl?: string };

/** Where a turn records its send. Hosted runs need a durable one. */
export interface SendJournal {
  read(turnKey: string): Promise<SendJournalEntry | undefined>;
  write(turnKey: string, entry: SendJournalEntry): Promise<void>;
}

export function createMemorySendJournal(): SendJournal {
  const entries = new Map<string, SendJournalEntry>();
  return {
    async read(turnKey) {
      return entries.get(turnKey);
    },
    async write(turnKey, entry) {
      entries.set(turnKey, entry);
    },
  };
}

export type RealUiTurnInput = {
  module: RealUiPageModule;
  driver: PageDriver;
  /** One per server the turn uses, each pointed at the forwarding endpoint. */
  connectors: ReadonlyArray<{ name: string; url: string }>;
  prompt: string;
  journal: SendJournal;
  /** Stable for the turn across restarts: the journal's key. */
  turnKey: string;
  stepTimeoutMs?: number;
  replyTimeoutMs?: number;
  signal?: AbortSignal;
  /** The email the project saved for this web account, when it has one. */
  expectedEmail?: string;
  /** Called when the turn starts a step, for progress, traces and recovery. */
  onStep?: (step: RealUiStep, pending: PendingStep) => void;
  /** Called the moment the prompt is about to be sent. */
  beforeSend?: () => void;
};

export type RealUiTurnResult = {
  account: WebAccountIdentity;
  conversation: SavedConversation;
  approvalsAnswered: number;
  finishedSignals: string[];
  /** The prompt was found already sent by an earlier attempt. */
  resumed: boolean;
};

const STEP_TIMEOUT_MS = 60_000;
const REPLY_TIMEOUT_MS = 5 * 60_000;
const REPLY_POLL_MS = 500;

export async function driveRealUiTurn(
  input: RealUiTurnInput,
): Promise<RealUiTurnResult> {
  const { module, driver, signal } = input;
  const ctx = { signal, timeoutMs: input.stepTimeoutMs ?? STEP_TIMEOUT_MS };
  let step: RealUiStep = "sign_in_check";
  let pending: PendingStep | undefined;
  // From the journal's sending record until the send is confirmed, the click
  // may have happened: the prompt may already be in a chat.
  let sendUnconfirmed = false;
  const enter = (next: RealUiStep) => {
    step = next;
    pending = { stepId: next, startedAt: new Date().toISOString(), turnId: input.turnKey };
    input.onStep?.(next, pending);
  };
  try {
    enter("sign_in_check");
    const account = await module.signedIn(driver, ctx);
    if (
      input.expectedEmail &&
      account.email?.toLowerCase() !== input.expectedEmail.toLowerCase()
    ) {
      throw needsSignIn(
        "wrong_account",
        "sign_in_check",
        "The browser is signed in to a different account than the one saved for this project.",
      );
    }
    enter("connector");
    const selected = input.connectors.map((connector) => connector.name);
    for (const connector of input.connectors) {
      await module.ensureConnector(driver, connector, ctx, selected);
    }

    let conversationUrl: string | undefined;
    let resumed = false;
    const journaled = await input.journal.read(input.turnKey);
    if (journaled) {
      enter("send");
      // A sent entry names its own chat. Another turn may have sent the same
      // prompt since, so the newest chat holding it can be someone else's,
      // and one from before the send began always is.
      const found =
        journaled.state === "sent" && journaled.conversationUrl
          ? { conversationUrl: journaled.conversationUrl }
          : await module.findSent(driver, input.prompt, ctx, journaled.at);
      if (!found) {
        throw new RealUiError({
          kind: "send_ambiguous",
          step: "send",
          message:
            "An earlier attempt may have sent this prompt, and no chat shows it. It was not sent again.",
        });
      }
      conversationUrl = found.conversationUrl;
      resumed = true;
      // Recorded with its chat, so a later restart comes straight back here
      // rather than search again and take a newer chat with the same prompt.
      await input.journal.write(input.turnKey, {
        state: "sent",
        at: journaled.at,
        conversationUrl,
      });
      await driver.navigate(conversationUrl);
    } else {
      enter("new_chat");
      await module.openNewChat(driver, ctx);
      enter("enable_connector");
      for (const connector of input.connectors) {
        await module.enableConnector(driver, connector.name, ctx);
      }
      enter("send");
      const sendingAt = new Date().toISOString();
      await input.journal.write(input.turnKey, {
        state: "sending",
        at: sendingAt,
      });
      sendUnconfirmed = true;
      input.beforeSend?.();
      const sent = await module.send(driver, input.prompt, ctx);
      conversationUrl = sent.conversationUrl;
      await input.journal.write(input.turnKey, {
        state: "sent",
        at: sendingAt,
        ...(conversationUrl ? { conversationUrl } : {}),
      });
      sendUnconfirmed = false;
    }

    enter("reply");
    let approvalsAnswered = 0;
    let finishedSignals: string[] = [];
    let personHasBrowser = false;
    try {
      await driver.waitFor(
        async () => {
          try {
            const blocked = await module.blocker(driver);
            if (blocked) throw new RealUiError({ ...blocked, step: "reply" });
            if (await module.answerApproval(driver, selected)) {
              approvalsAnswered += 1;
              personHasBrowser = false;
              return false;
            }
            const state = await module.replySignals(driver);
            finishedSignals = state.signals;
            personHasBrowser = false;
            return state.finished;
          } catch (error) {
            // A person took the browser in its pane, so nothing could be
            // read: the reply is neither finished nor failed. Wait for them
            // to hand it back, within the reply's own deadline.
            if (error instanceof PageDriverError && error.code === "person_has_browser") {
              personHasBrowser = true;
              return false;
            }
            throw error;
          }
        },
        {
          timeoutMs: input.replyTimeoutMs ?? REPLY_TIMEOUT_MS,
          intervalMs: REPLY_POLL_MS,
          signal,
          what: "the reply to finish",
        },
      );
    } catch (error) {
      if (personHasBrowser && error instanceof PageDriverError && error.code === "timeout") {
        throw new RealUiError({
          kind: "reply_timeout",
          step: "reply",
          message: "A person still had the browser when the reply's time ran out. Select Hand back, then run it again.",
        });
      }
      throw error;
    }
    conversationUrl ??= await driver.url();

    enter("read_conversation");
    const conversation = await module.readConversation(
      driver,
      conversationUrl,
      ctx,
    );
    return { account, conversation, approvalsAnswered, finishedSignals, resumed };
  } catch (error) {
    const typed = asRealUiError(error, step);
    // Once the journal says sending, a page that reads as changed may already
    // have sent the prompt, so the turn ends as ambiguous, not as a change.
    const failure =
      sendUnconfirmed && typed.failure.kind === "page_changed"
        ? { ...typed.failure, kind: "send_ambiguous" as const }
        : typed.failure;
    throw new RealUiError(failure, typed.pendingStep ?? pending);
  }
}

/** Every failure of a turn as a typed failure of the step it happened in. */
export function asRealUiError(error: unknown, step: RealUiStep): RealUiError {
  if (error instanceof RealUiError) return error;
  if (error instanceof PageDriverError) {
    if (error.code === "timeout" && step === "reply") {
      return new RealUiError({ kind: "reply_timeout", step, message: error.message });
    }
    if (error.code === "unknown_outcome" && step === "send") {
      return new RealUiError({ kind: "send_ambiguous", step, message: error.message });
    }
    if (error.code === "not_found" || error.code === "timeout") {
      return new RealUiError({ kind: "page_changed", step, message: error.message });
    }
    return new RealUiError({ kind: "driver", step, message: error.message });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new RealUiError({ kind: "driver", step, message });
}
