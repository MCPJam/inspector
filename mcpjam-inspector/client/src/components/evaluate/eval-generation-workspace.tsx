import { useLayoutEffect } from "react";
import { Button } from "@mcpjam/design-system/button";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { useChat } from "@ai-sdk/react";
import { getOrCreateAgentChat } from "@/lib/mcpjam-agent/agent-chat-instances";
import { useEvalPromptQueue } from "@/lib/mcpjam-agent/eval-scope";
import {
  evalSuiteKey,
  useEvalGeneration,
} from "@/lib/mcpjam-agent/eval-workspace";
import { EvalGeneratedDrafts } from "./eval-generated-drafts";

/** The other pane is the shared chat, mounted by the dashboard workspace. */
export function EvalGenerationWorkspace({
  projectId,
  suiteId,
  suiteName,
  sessionId,
}: {
  projectId: string;
  suiteId: string;
  suiteName: string;
  sessionId: string;
}) {
  useLayoutEffect(() => {
    const panel = useAgentPanelStore.getState();
    panel.setActiveSession(sessionId, projectId);
    panel.setOpen(true);
  }, [sessionId, projectId]);
  const { status, error, messages } = useChat({
    chat: getOrCreateAgentChat(sessionId).chat,
  });
  const pending = useEvalPromptQueue((s) => s.pending[sessionId]);
  const generation = useEvalGeneration(
    (s) => s.suites[evalSuiteKey({ projectId, suiteId })],
  );
  const awaitingApproval = messages
    .at(-1)
    ?.parts.some(
      (part) =>
        "state" in part &&
        part.state === "approval-requested" &&
        (part.type === "tool-ui_eval_generate_cases" ||
          (part.type === "dynamic-tool" &&
            part.toolName === "ui_eval_generate_cases")),
    );
  const hasDrafts = Boolean(generation?.drafts.length);
  // Streaming a refinement is chat activity, not a new generation job. Keep
  // the initial Generate handoff responsive before its tool starts, but use
  // actual generation state once a batch has been created.
  const preparingInitialGeneration =
    !generation &&
    (Boolean(pending) || status === "submitted" || status === "streaming");
  const busy =
    generation?.status === "running" ||
    preparingInitialGeneration ||
    awaitingApproval;
  return (
    <section
      data-testid="suite-case-generation-workspace"
      className="flex min-h-0 flex-1 flex-col gap-4"
    >
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Generate test cases</h2>
          <p className="text-xs text-muted-foreground">{suiteName}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const panel = useAgentPanelStore.getState();
            panel.setActiveSession(sessionId, projectId);
            panel.setOpen(true);
          }}
        >
          Open chat
        </Button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
        <EvalGeneratedDrafts
          projectId={projectId}
          suiteId={suiteId}
          suiteName={suiteName}
        />
        {busy && (
          <div
            role="status"
            aria-label="Generating test cases"
            className="space-y-3"
          >
            {!awaitingApproval && (
              <p className="text-sm text-muted-foreground">
                {hasDrafts
                  ? "Generating additional cases…"
                  : "Discovering your servers and drafting cases…"}
              </p>
            )}
            {[0, 1, 2].map((id) => (
              <div
                key={id}
                data-testid="generating-case-skeleton"
                className="space-y-3 rounded-xl border border-border p-4"
                aria-hidden="true"
              >
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-full animate-pulse rounded bg-muted" />
                <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error.message}
          </p>
        )}
        {!busy && !generation && !error && (
          <p className="text-sm text-muted-foreground">
            Describe the coverage you want in Ask MCPJam. Generated cases will
            appear here for review.
          </p>
        )}
      </div>
    </section>
  );
}
