import { useMemo } from "react";
import type { UIMessage } from "@ai-sdk/react";
import {
  getRenderableConversationMessages,
  ReadOnlyTranscript,
  TurnRating,
  type ReadOnlyTranscriptProps,
} from "@mcpjam/chat-ui";

import { useSharedChatTurnScores } from "@/hooks/useSharedChatThreads";

const USER_RATING_KEY = "user_rating";
const USER_THUMB_KEY = "user_thumb";
/** The per-turn keys a tester writes — one per widget style. */
const TURN_RATING_KEYS = [USER_RATING_KEY, USER_THUMB_KEY];

type TurnRatingRow = {
  value?: number;
  comment?: string;
  key: string;
  updatedAt: number;
};

interface SessionScoredTranscriptProps extends ReadOnlyTranscriptProps {
  threadId: string;
}

/**
 * The session transcript with each tester rating rendered under the response
 * it was left on.
 *
 * Split out from `ShareUsageThreadDetail` so the scores query lives in a
 * component an `ErrorBoundary` can replace: `useQuery` against a Convex
 * function that isn't deployed yet THROWS, and the transcript is the point of
 * the page — losing it because a not-yet-promoted backend function is missing
 * would be a far worse failure than losing the ratings. The boundary's
 * fallback is the plain transcript.
 */
export function SessionScoredTranscript({
  threadId,
  messages,
  ...transcriptProps
}: SessionScoredTranscriptProps) {
  const { scores } = useSharedChatTurnScores({ threadId });

  /**
   * Visible-message index → the rating on that turn.
   *
   * Scores are anchored by `promptIndex`, the 0-based ordinal of the USER
   * message that opened the turn — the same ordinal the backend derives from
   * `chatSessionTurnTraces`. The count has to run over the RENDERABLE messages
   * (`getRenderableConversationMessages`, which drops hidden internal
   * model-context/widget-state messages), because those hidden rows are not
   * prompts and counting them would shift every rating one turn late.
   */
  const ratingByVisibleIndex = useMemo(() => {
    const map = new Map<number, TurnRatingRow>();
    const ratings = (scores ?? []).filter((score) =>
      TURN_RATING_KEYS.includes(score.key)
    );
    if (ratings.length === 0) return map;

    const byPromptIndex = new Map<number, TurnRatingRow>();
    for (const score of ratings) {
      if (score.promptIndex === undefined) continue;
      // A turn can carry a row under BOTH keys — a scenario whose style was
      // switched, re-rated by the same tester. The latest revision is what
      // they currently mean, so it wins; `updatedAt` is the freshness axis the
      // backend maintains for exactly this.
      const existing = byPromptIndex.get(score.promptIndex);
      if (existing && existing.updatedAt >= score.updatedAt) continue;
      byPromptIndex.set(score.promptIndex, {
        value: score.value,
        comment: score.comment,
        key: score.key,
        updatedAt: score.updatedAt,
      });
    }

    const visible = getRenderableConversationMessages(messages);
    let promptIndex = -1;
    visible.forEach((message: UIMessage, index: number) => {
      if (message.role === "user") {
        promptIndex += 1;
        return;
      }
      if (message.role !== "assistant" || promptIndex < 0) return;
      const rating = byPromptIndex.get(promptIndex);
      // Only the FIRST assistant message of a turn carries the rating. A turn
      // that produced several assistant messages would otherwise repeat the
      // same stars under each one and read as several ratings.
      if (rating && !map.has(index)) {
        map.set(index, rating);
        byPromptIndex.delete(promptIndex);
      }
    });
    return map;
  }, [scores, messages]);

  return (
    <ReadOnlyTranscript
      {...transcriptProps}
      messages={messages}
      renderTurnFooter={(_message, index) => {
        const rating = ratingByVisibleIndex.get(index);
        if (!rating || rating.value === undefined) return null;
        return (
          <TurnRating
            readOnly
            // Render the widget the tester actually used. A 0 shown as stars
            // would read as "unrated"; a 4 shown as thumbs cannot be shown at
            // all.
            variant={rating.key === USER_THUMB_KEY ? "thumbs" : "stars"}
            value={rating.value}
            comment={rating.comment}
            status="submitted"
          />
        );
      }}
    />
  );
}
