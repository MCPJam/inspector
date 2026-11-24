/**
 * The adapter contract for a vendor's website, and the failures a run on it
 * can end in.
 *
 * A page module knows one site: where its controls are, how it says it is
 * signed in, how its connectors and chats work, and where it keeps a saved
 * conversation. The order of a turn (`drive-turn.ts`) is the same for every
 * site and lives outside the modules.
 *
 * Failures are typed so the run can say what happened and who can fix it.
 * Every one is a failure of the run, never of the project's server: nothing
 * about the server was measured when the page could not be driven.
 */
import type {
  PendingStep,
  SignInReason,
} from "../../../services/web-clients/recovery/backend.js";
import type { PageDriver } from "./page-driver.js";

export type RealUiStep =
  | "sign_in_check"
  | "connector"
  | "new_chat"
  | "enable_connector"
  | "send"
  | "reply"
  | "read_conversation";

/**
 * Why a person has to act before the run can continue: the reasons recovery
 * records. A `human_check` ("Verify you are human" or similar) is never
 * answered by MCPJam, and `wrong_account` is signed in, but not as the
 * account the project saved.
 */
export type NeedsSignInReason = SignInReason;

// The step a run was on, kept for each step so a stopped run can be resumed
// from it once a person has finished signing in. Recovery stores it as given;
// a page turn's `stepId` is a `RealUiStep`.
export type { PendingStep };

export type RealUiFailure =
  | {
      kind: "needs_sign_in";
      reason: NeedsSignInReason;
      step: RealUiStep;
      message: string;
    }
  | {
      kind:
        | "plan_limit"
        /** An expected control is missing: the site changed under the module. */
        | "page_changed"
        | "connector_failed"
        /** The prompt may have been sent; it is never sent a second time. */
        | "send_ambiguous"
        | "reply_timeout"
        /** The browser could not do what the module asked. */
        | "driver";
      step: RealUiStep;
      message: string;
    };

export class RealUiError extends Error {
  constructor(
    readonly failure: RealUiFailure,
    /** Set by the turn: the step the run stopped on. */
    readonly pendingStep?: PendingStep,
  ) {
    super(failure.message);
    this.name = "RealUiError";
  }
}

export function needsSignIn(
  reason: NeedsSignInReason,
  step: RealUiStep,
  message: string,
): RealUiError {
  return new RealUiError({ kind: "needs_sign_in", reason, step, message });
}

export function pageChanged(step: RealUiStep, message: string): RealUiError {
  return new RealUiError({ kind: "page_changed", step, message });
}

export type WebAccountIdentity = { email?: string; workspace?: string };

/** One tool call as the vendor's own saved conversation records it. */
export type ConversationToolCall = {
  toolName: string;
  /** The id the vendor also sends as `_meta["claudecode/toolUseId"]`. */
  toolUseId?: string;
  /** ISO time the vendor recorded for the call, when it records one. */
  at?: string;
};

export type SavedConversation = {
  conversationId: string;
  url: string;
  userPrompt?: string;
  /** The last assistant reply, as the vendor saved it. */
  replyText: string;
  toolCalls: ConversationToolCall[];
};

export type StepContext = { signal?: AbortSignal; timeoutMs: number };

export interface RealUiPageModule {
  readonly id: string;
  /** Pinned by date in `WEB_CLIENT_PAGE_MODULE_VERSIONS` for the vendors. */
  readonly version: string;
  /** The only sites the signed-in browser may open for this module. */
  readonly sites: readonly string[];
  /** Signed in with a usable chat, and whose account it is. */
  signedIn(driver: PageDriver, ctx: StepContext): Promise<WebAccountIdentity>;
  /** A sign-in step, human check or plan wall on the page now, if any. */
  blocker(driver: PageDriver): Promise<RealUiFailure | undefined>;
  /**
   * The connector named `name` exists, points at `url` and is connected.
   * A broken one is removed and added again, never reconnected.
   */
  ensureConnector(
    driver: PageDriver,
    connector: { name: string; url: string },
    ctx: StepContext,
  ): Promise<void>;
  openNewChat(driver: PageDriver, ctx: StepContext): Promise<void>;
  enableConnector(driver: PageDriver, name: string, ctx: StepContext): Promise<void>;
  /** Sends `prompt` once; resolves with the chat it landed in, when known. */
  send(
    driver: PageDriver,
    prompt: string,
    ctx: StepContext,
  ): Promise<{ conversationUrl?: string }>;
  /** After a restart: the chat that already holds this prompt, if any. */
  findSent(
    driver: PageDriver,
    prompt: string,
    ctx: StepContext,
  ): Promise<{ conversationUrl: string } | undefined>;
  /** Answers the app's own tool approval prompt; true when it answered one. */
  answerApproval(driver: PageDriver): Promise<boolean>;
  /** Each positive sign the reply has finished; done only when all hold. */
  replySignals(
    driver: PageDriver,
  ): Promise<{ finished: boolean; signals: string[] }>;
  readConversation(
    driver: PageDriver,
    conversationUrl: string,
    ctx: StepContext,
  ): Promise<SavedConversation>;
}

const HUMAN_CHECK_TEXT =
  /verify you are human|security verification|checking your browser|just a moment|are you a robot/i;

/**
 * Blockers every site shares: a human check, a password or code field, an
 * authorization consent page. Read from the page, never acted on.
 */
export async function commonBlocker(
  driver: PageDriver,
  options: { challengeSelectors: readonly string[]; step: RealUiStep },
): Promise<RealUiFailure | undefined> {
  const { step } = options;
  for (const selector of options.challengeSelectors) {
    if ((await driver.readText(selector)) !== undefined) {
      return {
        kind: "needs_sign_in",
        reason: "human_check",
        step,
        message: "The site is asking to verify a person is there.",
      };
    }
  }
  const body = (await driver.readText("body")) ?? "";
  if (HUMAN_CHECK_TEXT.test(body)) {
    return {
      kind: "needs_sign_in",
      reason: "human_check",
      step,
      message: "The site is asking to verify a person is there.",
    };
  }
  if ((await driver.readText('input[autocomplete="one-time-code"]')) !== undefined) {
    return {
      kind: "needs_sign_in",
      reason: "mfa",
      step,
      message: "The site is asking for a verification code.",
    };
  }
  if ((await driver.readText('input[type="password"]')) !== undefined) {
    return {
      kind: "needs_sign_in",
      reason: "password",
      step,
      message: "The site is asking for the account's password.",
    };
  }
  const path = new URL(await driver.url()).pathname;
  if (/\/(oauth|authorize|consent)\b/i.test(path)) {
    return {
      kind: "needs_sign_in",
      reason: "consent",
      step,
      message: "The site is asking someone to approve access.",
    };
  }
  return undefined;
}

/** Escapes text for use inside a CSS attribute selector's quotes. */
export function cssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
