import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { useAction } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { X } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { useAnnouncementSlot } from "@/components/announcement-slot";
import { SaveAsTestCaseAction } from "@/components/chat-v2/shared/save-as-test-case-action";
import { usePromoteCapability } from "@/hooks/usePromoteCapability";
import { track } from "@/lib/analytics";
import {
  findRepeatInConversation,
  latestToolPromptTurn,
  type PromptTurn,
} from "./repeat-prompt-match";

const findSimilarPlaygroundPrompt = makeFunctionReference<
  "action",
  {
    projectId: string;
    chatSessionId: string;
    prompt: string;
    serverNames: string[];
  },
  { promptText: string } | null
>("chatSessionPromote:findSimilarPlaygroundPrompt");

const SEEN_KEY_PREFIX = "mcpjam:playground-repeat-tip";

function seenKey(projectId: string, serverName: string): string {
  return `${SEEN_KEY_PREFIX}:${projectId}:${serverName.toLowerCase()}`;
}

type RepeatMatch = { turn: PromptTurn; similarText: string };

type RepeatPromptTipProps = {
  projectId: string | null;
  chatSessionId: string;
  messages: UIMessage[];
  isStreaming: boolean;
  serverNames: string[];
  /** Clients the prompt ran on; pre-attached to a new suite. */
  hostIds: string[];
};

/**
 * Tip above the composer when the latest prompt repeats an earlier one, in
 * this conversation or a past one. Shown at most once per server.
 */
export function RepeatPromptTip({
  projectId,
  chatSessionId,
  messages,
  isStreaming,
  serverNames,
  hostIds,
}: RepeatPromptTipProps) {
  const { canPromote } = usePromoteCapability({ projectId });
  const findSimilar = useAction(findSimilarPlaygroundPrompt);
  const [match, setMatch] = useState<RepeatMatch | null>(null);
  const [hidden, setHidden] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const checkedKey = useRef<string | null>(null);
  const serverName = serverNames[0] ?? null;
  const alreadySeen =
    projectId !== null &&
    serverName !== null &&
    localStorage.getItem(seenKey(projectId, serverName)) !== null;
  const canCheck = canPromote && !alreadySeen && !hidden && !match;

  useEffect(() => {
    if (!canCheck || isStreaming || !projectId) return;
    const turn = latestToolPromptTurn(messages);
    if (!turn) return;
    const key = `${chatSessionId}:${turn.promptIndex}`;
    if (checkedKey.current === key) return;
    checkedKey.current = key;

    const local = findRepeatInConversation(messages, turn);
    if (local) {
      setMatch({ turn, similarText: local });
      return;
    }
    let cancelled = false;
    findSimilar({
      projectId,
      chatSessionId,
      prompt: turn.text,
      serverNames,
    })
      .then((result) => {
        if (!cancelled && result) {
          setMatch({ turn, similarText: result.promptText });
        }
      })
      .catch((error: unknown) => {
        console.warn("Repeat prompt lookup failed", error);
      });
    return () => {
      cancelled = true;
    };
  }, [
    canCheck,
    isStreaming,
    projectId,
    chatSessionId,
    messages,
    serverNames,
    findSimilar,
  ]);

  const { open, contentRef } = useAnnouncementSlot(
    match !== null && !hidden && serverName !== null,
  );

  useEffect(() => {
    if (!open || !projectId || !serverName) return;
    localStorage.setItem(seenKey(projectId, serverName), "seen");
    track("playground_repeat_tip_shown", { location: "playground" });
  }, [open, projectId, serverName]);

  if (!match || !projectId) return null;

  return (
    <>
      {open && (
        <div
          ref={contentRef}
          role="status"
          className="mb-2 flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-xs"
        >
          <Badge variant="secondary">Tip</Badge>
          <p className="min-w-0 flex-1 truncate text-muted-foreground">
            You&apos;ve asked {serverName} this before. Save it as a test case
            to rerun it anytime.
          </p>
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0"
            onClick={() => {
              track("playground_repeat_tip_clicked", {
                location: "playground",
              });
              setHidden(true);
              setDialogOpen(true);
            }}
          >
            Save as test case
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Dismiss tip"
            onClick={() => {
              track("playground_repeat_tip_dismissed", {
                location: "playground",
              });
              setHidden(true);
            }}
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      )}
      <SaveAsTestCaseAction
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        chatSessionId={chatSessionId}
        promptIndex={match.turn.promptIndex}
        promptPreview={match.turn.text}
        projectId={projectId}
        suggestedHostIds={hostIds}
        similarPromptText={match.similarText}
      />
    </>
  );
}
