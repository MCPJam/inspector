/**
 * The handover when the reviewer sign-in stops for a person: what the page
 * asked for, who can change the sign-in, and how the attempt is resumed.
 */
import { useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Button } from "@mcpjam/design-system/button";
import { createReviewerHandoff, type ReviewerAttempt } from "@/lib/apis/reviewer-attempts-api";
import { copyToClipboard } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import type { Handover } from "./reviewer-stages";
import { ApproximatedLabel, FrameButton } from "./ReviewerStages";

export function ReviewerHandover({
  attempt,
  handover,
  scope,
  onShow,
}: {
  attempt: ReviewerAttempt;
  handover: Handover | null;
  scope: { projectId: string; submissionId: string };
  /** Shows the page it stopped on; absent when the recording cannot. */
  onShow?: () => void;
}) {
  const [link, setLink] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createLink = async () => {
    setOpening(true);
    setError(null);
    try {
      const result = await createReviewerHandoff(scope, attempt.id);
      setLink(result.handoffUrl);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpening(false);
    }
  };
  const command = `mcpjam readiness reviewer resume ${scope.submissionId} --attempt ${attempt.id} --project ${scope.projectId}`;
  const copy = async () => {
    if (await copyToClipboard(command)) {
      toast.success("Resume command copied.");
    } else {
      toast.error(
        "The resume command was not copied. Copy the attempt id from this page.",
      );
    }
  };
  const term = "text-xs text-muted-foreground";
  return (
    <div className="space-y-2 rounded-md border border-warning/70 bg-warning/10 p-3">
      {attempt.humanSignInCompletedAt ? (
        <p>Reviewer sign-in completed. Resume this attempt to run the checks.</p>
      ) : (
        <div className="space-y-2">
          <Button type="button" disabled={opening} onClick={() => void createLink()}>
            {opening ? "Creating sign-in link…" : "Finish reviewer sign-in"}
          </Button>
          {link ? <a href={link} target="_blank" rel="noopener noreferrer">Open reviewer sign-in</a> : null}
          {error ? <p role="alert">{error}</p> : null}
        </div>
      )}
      <dl className="space-y-3">
        {handover ? (
          <>
            <div className="space-y-1">
              <dt className={term}>What the page asked for</dt>
              <dd className="[overflow-wrap:anywhere]">
                {handover.approximated ? <ApproximatedLabel /> : null}
                {handover.asked}
                {onShow ? (
                  <FrameButton
                    label="the page the sign-in stopped on"
                    onShow={onShow}
                  />
                ) : null}
              </dd>
            </div>
            <div className="space-y-1">
              <dt className={term}>Who can finish it</dt>
              <dd>{handover.finisher}</dd>
              <dd className="font-medium">{handover.action}</dd>
            </div>
          </>
        ) : null}
        <div className="space-y-1">
          <dt className={term}>How to resume it</dt>
          <dd className="text-muted-foreground">
            A teammate or an agent can resume this attempt with its id.
          </dd>
          <dd className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Attempt id</span>
            <code className="font-code">{attempt.id}</code>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void copy()}
            >
              Copy resume command
            </Button>
          </dd>
        </div>
      </dl>
      {handover ? (
        <p className="text-xs text-muted-foreground">
          {`Paused ${formatDistanceToNow(handover.since, { addSuffix: true })}.`}
        </p>
      ) : null}
    </div>
  );
}
