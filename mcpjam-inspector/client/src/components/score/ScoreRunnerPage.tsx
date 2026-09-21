import { useEffect, useReducer, type FormEvent } from "react";
import { ScoreRunnerView } from "./ScoreRunnerView";
import {
  INITIAL_SCORE_RUN_DRAFT,
  acceptScoreDeliveryEmail,
  acceptScoreServerUrl,
  restoreScoreRunDraft,
  scoreRunDraftReducer,
} from "./score-run-draft";
import { useScoreRunnerController } from "./use-score-runner-controller";

const INVALID_URL_MESSAGE = "Enter a valid http(s) MCP server URL.";
const INVALID_EMAIL_MESSAGE = "Enter a valid email address.";

export function ScoreRunnerPage({
  convexProjectId,
}: {
  convexProjectId: string | null;
}) {
  const [draft, dispatch] = useReducer(
    scoreRunDraftReducer,
    INITIAL_SCORE_RUN_DRAFT,
  );
  const controller = useScoreRunnerController({ convexProjectId });

  const {
    resumeRecord,
    consumeResumeRecord,
    beginRun,
    requestDeliveryEmail,
    reportInputError,
  } = controller;

  useEffect(() => {
    if (!resumeRecord) return;

    consumeResumeRecord();
    const restored = restoreScoreRunDraft(resumeRecord);
    if (restored.kind === "discard") return;

    dispatch({ type: "replace", draft: restored.draft });
    if (restored.kind === "collect-email") requestDeliveryEmail();
    if (restored.kind === "run") beginRun(restored.intent);
  }, [beginRun, consumeResumeRecord, requestDeliveryEmail, resumeRecord]);

  const submitServerUrl = (event: FormEvent) => {
    event.preventDefault();
    const accepted = acceptScoreServerUrl(draft);
    if (!accepted.ok) {
      reportInputError(INVALID_URL_MESSAGE);
      return;
    }

    dispatch({ type: "replace", draft: accepted.value });
    requestDeliveryEmail();
  };

  const submitDeliveryEmail = (event: FormEvent) => {
    event.preventDefault();
    const accepted = acceptScoreDeliveryEmail(draft);
    if (!accepted.ok) {
      reportInputError(INVALID_EMAIL_MESSAGE);
      return;
    }

    dispatch({ type: "replace", draft: accepted.value.draft });
    beginRun(accepted.value.intent);
  };

  return (
    <ScoreRunnerView
      urlInput={draft.urlInput}
      onUrlChange={(value) => dispatch({ type: "edit-url", value })}
      onSubmit={submitServerUrl}
      emailInput={draft.emailInput}
      onEmailChange={(value) => dispatch({ type: "edit-email", value })}
      onEmailSubmit={submitDeliveryEmail}
      phase={controller.phase}
      error={controller.error}
      busy={controller.busy}
      formDisabled={controller.formDisabled}
      appReadyMessage={controller.appReadyMessage}
      resultUrl={controller.resultUrl}
      copied={controller.copied}
      onCopy={controller.copyResultUrl}
      showAuthorize={controller.showAuthorize}
      onAuthorize={controller.authorizeServer}
      authorizeBusy={controller.authorizeBusy}
    />
  );
}
