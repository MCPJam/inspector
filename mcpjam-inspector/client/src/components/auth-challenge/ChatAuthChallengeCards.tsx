import { useState } from "react";
import {
  useAuthChallengeNoticeStore,
  useChatAuthChallengeCards,
} from "@/lib/auth-challenge-lifecycle";
import {
  AuthChallengeCard,
  authChallengeConnectMessage,
} from "./AuthChallengeCard";

/**
 * The sign-in cards and developer notices for one assistant message's tool
 * calls. Notices are display-only: nothing here starts a sign-in except a
 * card's own trusted Connect click.
 */
export function ChatAuthChallengeCards({
  toolCallIds,
}: {
  toolCallIds: readonly string[];
}) {
  const cards = useChatAuthChallengeCards(toolCallIds);
  const notices = useAuthChallengeNoticeStore((state) => state.notices);
  const [message, setMessage] = useState<string | null>(null);
  const messageNotices = toolCallIds
    .map((id) => notices[id])
    .filter((notice) => notice !== undefined);
  if (cards.length === 0 && messageNotices.length === 0 && !message) {
    return null;
  }
  return (
    <div className="space-y-2 pt-3" data-testid="chat-auth-challenge">
      {cards.map((card) => (
        <AuthChallengeCard
          key={card.key}
          card={card}
          server={card.server}
          onResult={(result) =>
            setMessage(authChallengeConnectMessage(result) ?? null)
          }
        />
      ))}
      {messageNotices.map((notice) => (
        <p
          key={notice.toolCallId}
          className="text-xs text-muted-foreground"
          data-testid="auth-challenge-notice"
        >
          {notice.explanation}
        </p>
      ))}
      {message ? (
        <p className="text-xs text-muted-foreground">{message}</p>
      ) : null}
    </div>
  );
}
