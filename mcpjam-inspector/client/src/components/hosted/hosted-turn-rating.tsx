import { useEffect } from "react";
import { TurnRating } from "@mcpjam/chat-ui";

import type {
  TurnRatingState,
  UseScenarioTurnRatingResult,
} from "@/hooks/useScenarioTurnRating";
import type { ScenarioPerTurnFeedbackPayload } from "@/lib/scenario-session";

interface HostedTurnRatingProps {
  chatSessionId: string;
  /**
   * Server-minted turn id. `null` until the turn's `turn_start` trace event
   * lands — the backend anchors a score on this id, so there is nothing to
   * submit until then.
   */
  turnId: string | null;
  config: ScenarioPerTurnFeedbackPayload;
  rating: UseScenarioTurnRatingResult;
}

/**
 * One rating widget under one assistant response on the hosted tester page.
 *
 * A component rather than inline JSX because the chat session id is minted
 * inside `ChatTabV2` and only surfaces through its per-turn render callback —
 * this reports it upward so the rehydration query knows which session to read.
 */
export function HostedTurnRating({
  chatSessionId,
  turnId,
  config,
  rating,
}: HostedTurnRatingProps) {
  const { observeChatSession } = rating;
  useEffect(() => {
    observeChatSession(chatSessionId);
  }, [observeChatSession, chatSessionId]);

  // No anchor yet ⇒ no widget. Showing stars that cannot be saved is worse
  // than showing nothing: the tester spends the intent and gets an error.
  if (!turnId) return null;

  const state: TurnRatingState = rating.getState(chatSessionId, turnId);

  return (
    <TurnRating
      // The single switch point between the two widget styles. The hook is
      // told the matching score key by the page, so the control the tester
      // sees and the key their click writes cannot disagree.
      variant={config.style === "thumbs" ? "thumbs" : "stars"}
      value={state.value}
      comment={state.comment}
      status={state.status}
      title={config.prompt}
      commentPlaceholder={config.commentPlaceholder}
      thanksMessage={config.thanksMessage}
      onSubmit={({ value, comment }) =>
        rating.submit({ chatSessionId, turnId, value, comment })
      }
    />
  );
}
