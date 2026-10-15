import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/chat-utils";
import {
  useHarnessAgentActivity,
  type HarnessAgentStep,
} from "@/stores/harness-agent-activity-store";
import { describeHarnessToolStep } from "./harness-tool-steps";
import type { ToolState } from "./thread-helpers";

type RunState = "running" | "done" | "failed" | "stopped";

/**
 * A background agent's own status wins: its Agent call returns at once, while
 * the work goes on. Otherwise the call's state is the agent's.
 */
function runStateOf(
  backgroundStatus: string | undefined,
  toolState: ToolState | undefined,
): RunState {
  if (backgroundStatus) {
    if (backgroundStatus === "running" || backgroundStatus === "pending") {
      return "running";
    }
    if (backgroundStatus === "failed") return "failed";
    if (backgroundStatus === "stopped" || backgroundStatus === "killed") {
      return "stopped";
    }
    return "done";
  }
  if (toolState === "output-error") return "failed";
  if (toolState === "output-denied") return "stopped";
  if (toolState === "output-available") return "done";
  return "running";
}

function stepCount(n: number): string {
  return n === 1 ? "1 step" : `${n} steps`;
}

function StepRow({
  step,
  agentRunning,
}: {
  step: HarnessAgentStep;
  agentRunning: boolean;
}) {
  const label = describeHarnessToolStep(step.toolName, step.input);
  return (
    <li
      className={cn("flex min-w-0 items-center gap-2", step.nested && "pl-4")}
      data-testid="harness-agent-step"
    >
      <span className="shrink-0 text-foreground">{label.verb}</span>
      {label.detail && (
        <span
          className={cn(
            "min-w-0 truncate text-muted-foreground",
            label.code && "font-mono",
          )}
          title={label.title}
        >
          {label.detail}
        </span>
      )}
      {step.status === "error" ? (
        <span title={step.error} className="inline-flex shrink-0">
          <X className="h-3 w-3 text-destructive" aria-hidden="true" />
          <span className="sr-only">Failed</span>
        </span>
      ) : step.status === undefined && agentRunning ? (
        <Loader2
          className="h-3 w-3 shrink-0 animate-spin text-muted-foreground"
          aria-label="Running"
        />
      ) : null}
    </li>
  );
}

/**
 * What a harness's Agent call is doing, on its card: one summary row, and the
 * subagent's steps under it. Open while the agent works, folded once it is
 * done, unless the user chose. Renders nothing for a call with no activity,
 * so every other tool card is unchanged.
 */
export function HarnessAgentActivity({
  toolCallId,
  toolState,
  description,
}: {
  toolCallId: string | undefined;
  toolState: ToolState | undefined;
  description?: string;
}) {
  const { activity, dropped } = useHarnessAgentActivity(toolCallId);
  const [userOpen, setUserOpen] = useState<boolean | undefined>(undefined);
  const listRef = useRef<HTMLOListElement>(null);
  const stepTotal = (activity?.steps.length ?? 0) + dropped;
  const runState = runStateOf(activity?.backgroundStatus, toolState);
  const running = runState === "running";
  const open = userOpen ?? running;

  // Follow the newest step while the agent works.
  useEffect(() => {
    if (!open || !running) return;
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [open, running, stepTotal]);

  if (
    !activity ||
    (activity.steps.length === 0 && !activity.backgroundStatus)
  ) {
    return null;
  }

  const title = description?.trim() || "Subagent";
  const outcome =
    runState === "failed"
      ? "failed"
      : runState === "stopped"
        ? "stopped"
        : undefined;

  return (
    <Collapsible
      open={open}
      onOpenChange={setUserOpen}
      className="border-t border-border/40 px-3 py-2"
      data-testid="harness-agent-activity"
    >
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground">
        {running ? (
          <Loader2
            className="h-3.5 w-3.5 shrink-0 animate-spin"
            aria-hidden="true"
          />
        ) : runState === "done" ? (
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <X
            className="h-3.5 w-3.5 shrink-0 text-destructive"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 truncate text-foreground">{title}</span>
        <span className="shrink-0">
          {[
            running ? "working" : undefined,
            stepTotal > 0 ? stepCount(stepTotal) : undefined,
            outcome,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-150",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      {activity.steps.length > 0 && (
        <CollapsibleContent>
          <ol
            ref={listRef}
            className="mt-2 ml-[6px] max-h-56 space-y-1 overflow-y-auto border-l border-border/60 pl-3 text-xs"
          >
            {dropped > 0 && (
              <li className="text-muted-foreground">
                {stepCount(dropped)} earlier
              </li>
            )}
            {activity.steps.map((step) => (
              <StepRow
                key={step.toolUseId}
                step={step}
                agentRunning={running}
              />
            ))}
          </ol>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
