/**
 * Compact feedback mark shared by the sessions list row and the thread
 * header so the two can never disagree about what a session's ratings say.
 *
 * Stars: filled star + average. Thumbs: count-then-emoji tallies. Mixed:
 * both. No feedback: an em dash with an accessible name.
 */
import { Star } from "lucide-react";
import {
  feedbackHeadline,
  type FeedbackHeadline,
} from "@/components/connection/share-usage/feedback-headline";
import type { SharedChatThread } from "@/hooks/useSharedChatThreads";
import { cn } from "@/lib/utils";

export function sessionFeedbackTone(min: number | null): "low" | "default" {
  return min != null && min <= 2 ? "low" : "default";
}

function ThumbTallies({ up, down }: { up: number; down: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      {up > 0 ? (
        <>
          <span>{up}</span>
          <span aria-hidden>👍</span>
        </>
      ) : null}
      {down > 0 ? (
        <>
          <span>{down}</span>
          <span aria-hidden>👎</span>
        </>
      ) : null}
    </span>
  );
}

function StarsMark({ avg }: { avg: number }) {
  return (
    <span className="inline-flex items-center gap-1">
      <Star
        aria-hidden
        className="size-2.5 fill-primary text-primary"
        strokeWidth={1.5}
      />
      <span>{avg.toFixed(1)}</span>
    </span>
  );
}

function renderHeadline(headline: FeedbackHeadline) {
  if (headline.kind === "thumbs") {
    return <ThumbTallies up={headline.up} down={headline.down} />;
  }
  if (headline.kind === "mixed") {
    return (
      <span className="inline-flex items-center gap-1">
        <StarsMark avg={headline.avg} />
        <ThumbTallies up={headline.up} down={headline.down} />
      </span>
    );
  }
  return <StarsMark avg={headline.avg} />;
}

export function SessionFeedbackMark({
  thread,
  variant = "row",
}: {
  thread: SharedChatThread;
  variant?: "row" | "header";
}) {
  const summary = thread.feedback ?? null;
  const rating = summary?.min ?? thread.feedbackRating ?? null;
  const headline = summary
    ? feedbackHeadline(summary)
    : thread.feedbackRating != null
      ? {
          kind: "stars" as const,
          avg: thread.feedbackRating,
          count: 1,
        }
      : null;
  const tone = sessionFeedbackTone(rating);
  const count = summary?.count ?? (headline ? 1 : 0);

  if (!headline) {
    if (variant === "header") return null;
    return (
      <span
        className="font-medium text-muted-foreground"
        aria-label="No feedback"
      >
        —
      </span>
    );
  }

  const caption =
    variant === "header" && count > 0
      ? headline.kind === "thumbs"
        ? `across ${count} ${count === 1 ? "turn" : "turns"}`
        : `avg across ${count} ${count === 1 ? "turn" : "turns"}`
      : null;

  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 font-medium",
        variant === "header" ? "text-[13px]" : "text-xs",
        tone === "low"
          ? "text-amber-700 dark:text-amber-400"
          : "text-card-foreground",
      )}
      data-rating-tone={tone}
    >
      {renderHeadline(headline)}
      {caption ? (
        <span className="font-normal text-muted-foreground">{caption}</span>
      ) : null}
    </span>
  );
}
