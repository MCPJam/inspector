import type { ScoreRunResumeRecord } from "./score-run-resume";
import { normalizeScoreEmail } from "./score-email";
import { normalizeScoreUrl } from "./score-url";

export interface ScoreRunDraft {
  urlInput: string;
  emailInput: string;
  serverUrl?: string;
}

export interface ScoreRunIntent {
  serverUrl: string;
  deliveryEmail: string;
}

export type ScoreRunDraftAction =
  | { type: "edit-url"; value: string }
  | { type: "edit-email"; value: string }
  | { type: "replace"; draft: ScoreRunDraft };

export type DraftValidation<T> = { ok: true; value: T } | { ok: false };

export type RestoredScoreRun =
  | { kind: "discard" }
  | { kind: "collect-email"; draft: ScoreRunDraft }
  | { kind: "run"; draft: ScoreRunDraft; intent: ScoreRunIntent };

export const INITIAL_SCORE_RUN_DRAFT: ScoreRunDraft = {
  urlInput: "",
  emailInput: "",
};

export function scoreRunDraftReducer(
  draft: ScoreRunDraft,
  action: ScoreRunDraftAction,
): ScoreRunDraft {
  if (action.type === "edit-url") {
    // Editing the URL revokes its acceptance. Otherwise a later email
    // acceptance would mint an intent for the URL the visitor just replaced.
    return { ...draft, urlInput: action.value, serverUrl: undefined };
  }
  if (action.type === "edit-email") {
    return { ...draft, emailInput: action.value };
  }
  return action.draft;
}

export function acceptScoreServerUrl(
  draft: ScoreRunDraft,
): DraftValidation<ScoreRunDraft> {
  const serverUrl = normalizeScoreUrl(draft.urlInput);
  if (!serverUrl) return { ok: false };

  return {
    ok: true,
    value: { ...draft, urlInput: serverUrl, serverUrl },
  };
}

export function acceptScoreDeliveryEmail(
  draft: ScoreRunDraft,
): DraftValidation<{ draft: ScoreRunDraft; intent: ScoreRunIntent }> {
  if (!draft.serverUrl) return { ok: false };
  const deliveryEmail = normalizeScoreEmail(draft.emailInput);
  if (!deliveryEmail) return { ok: false };

  return {
    ok: true,
    value: {
      draft: { ...draft, emailInput: deliveryEmail },
      intent: { serverUrl: draft.serverUrl, deliveryEmail },
    },
  };
}

export function restoreScoreRunDraft(
  record: ScoreRunResumeRecord,
): RestoredScoreRun {
  const serverUrl = normalizeScoreUrl(record.serverUrl);
  if (!serverUrl) return { kind: "discard" };

  const deliveryEmail = normalizeScoreEmail(record.deliveryEmail ?? "");
  const draft: ScoreRunDraft = {
    urlInput: serverUrl,
    emailInput: deliveryEmail ?? "",
    serverUrl,
  };

  if (!deliveryEmail) return { kind: "collect-email", draft };
  return {
    kind: "run",
    draft,
    intent: { serverUrl, deliveryEmail },
  };
}
