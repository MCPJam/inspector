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
    excludeChatSessionIds?: string[];
  },
  { promptText: string } | null
>("chatSessionPromote:findSimilarPlaygroundPrompt");

const SEEN_KEY_PREFIX = "mcpjam:playground-repeat-tip";

function seenKey(projectId: string, serverName: string): string {
  return `${SEEN_KEY_PREFIX}:${projectId}:${serverName.toLowerCase()}`;
}

type RepeatMatch = { turn: PromptTurn; chatSessionId: string };

type RepeatPromptTipProps = {
  projectId: string | null;
  chatSessionId: string;
  messages: UIMessage[];
  isStreaming: boolean;
  serverNames: string[];
  /** Clients the prompt ran on; pre-attached to a new suite. */
  hostIds: string[];
  /** Sibling compare-mode sessions that got the same prompt. */
  excludeChatSessionIds?: string[];
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
  excludeChatSessionIds,
}: RepeatPromptTipProps) {
  const { canPromote } = usePromoteCapability({ projectId });
  const findSimilar = useAction(findSimilarPlaygroundPrompt);
  const [match, setMatch] = useState<RepeatMatch | null>(null);
  // A match belongs to the conversation it was found in; New chat drops it.
  const current = match?.chatSessionId === chatSessionId ? match : null;
  const [hidden, setHidden] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const checkedKey = useRef<string | null>(null);
  const excludeRef = useRef<string[]>([]);
  excludeRef.current = excludeChatSessionIds ?? [];
  const serverName = serverNames[0] ?? null;
  const alreadySeen =
    projectId !== null &&
    serverName !== null &&
    localStorage.getItem(seenKey(projectId, serverName)) !== null;
  const canCheck = canPromote && !alreadySeen && !hidden && !current;

  useEffect(() => {
    if (!canCheck || isStreaming || !projectId) return;
    const turn = latestToolPromptTurn(messages);
    if (!turn) return;
    const key = `${chatSessionId}:${turn.promptIndex}`;
    if (checkedKey.current === key) return;
    checkedKey.current = key;

    const local = findRepeatInConversation(messages, turn);
    if (local) {
      setMatch({ turn, chatSessionId });
      return;
    }
    findSimilar({
      projectId,
      chatSessionId,
      prompt: turn.text,
      serverNames,
      excludeChatSessionIds: excludeRef.current.filter(
        (id) => id !== chatSessionId,
      ),
    })
      .then((result) => {
        // Re-renders don't cancel the lookup; a newer turn does.
        if (result && checkedKey.current === key) {
          setMatch({ turn, chatSessionId });
        }
      })
      .catch((error: unknown) => {
        console.warn("Repeat prompt lookup failed", error);
      });
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
    current !== null && !hidden && serverName !== null,
  );

  useEffect(() => {
    if (!open || !projectId || !serverName) return;
    localStorage.setItem(seenKey(projectId, serverName), "seen");
    track("playground_repeat_tip_shown", { location: "playground" });
  }, [open, projectId, serverName]);

  if (!current || !projectId) return null;

  return (
    <>
      {open && (
        <div className="relative h-0">
          <div
            ref={contentRef}
            role="status"
            className="absolute inset-x-0 bottom-full z-10 mb-2 flex items-center gap-3 rounded-lg bg-card py-2 pl-3 pr-2 text-sm shadow-md duration-500 ease-out animate-in fade-in slide-in-from-bottom-4 motion-reduce:animate-none"
          >
            <Badge>Tip</Badge>
            <p className="min-w-0 flex-1 text-foreground">
              You&apos;ve asked {serverName} this before. Save it as a test case
              for your evals to rerun it anytime.
            </p>
            <Button
              variant="link"
              size="sm"
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
              size="sm"
              aria-label="Dismiss tip"
              onClick={() => {
                track("playground_repeat_tip_dismissed", {
                  location: "playground",
                });
                setHidden(true);
              }}
            >
              <X aria-hidden />
            </Button>
          </div>
        </div>
      )}
      <SaveAsTestCaseAction
        source="repeat_tip"
        serverNames={serverNames}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        chatSessionId={chatSessionId}
        promptIndex={current.turn.promptIndex}
        promptPreview={current.turn.text}
        projectId={projectId}
        suggestedHostIds={hostIds}
      />
    </>
  );
}
