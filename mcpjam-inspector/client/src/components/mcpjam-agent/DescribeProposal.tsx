import {
  isEvalContextReady,
  readEvalContext,
  useEvalContextVersion,
} from "@/lib/mcpjam-agent/eval-workspace";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import { useState } from "react";
import { Button } from "@mcpjam/design-system/button";
import type { EvalAgentScope } from "@/shared/eval-agent-scope";
import {
  createDescribeCases,
  useDescribeFlow,
} from "@/lib/mcpjam-agent/describe-flow";

export function DescribeProposal({
  sessionId,
  scope,
  busy,
}: {
  sessionId: string;
  scope: EvalAgentScope;
  busy: boolean;
}) {
  useEvalContextVersion((s) => s.version);
  const flow = useDescribeFlow((s) => s.sessions[sessionId]);
  const [error, setError] = useState<string>();
  if (flow?.phase === "clarifying")
    return (
      <div
        className="mx-4 space-y-2 rounded-lg border border-primary bg-primary/5 p-4 ring-4 ring-primary/15"
        role="status"
      >
        <p className="text-xs font-semibold text-primary">Your input needed</p>
        <p className="text-sm font-medium text-foreground">{flow.question}</p>
        <p className="text-xs text-muted-foreground">
          Reply in the message box below.
        </p>
      </div>
    );
  const proposal = flow?.proposal;
  if (!proposal) return null;
  const count = proposal.cases.length;
  const contextReady =
    isEvalContextReady(scope) &&
    (count === 1 || readEvalContext(scope).suiteStatus === "ready");
  if (flow.phase === "reviewing")
    return (
      <p className="px-4 text-sm" role="status">
        Created {count} unsaved {count === 1 ? "test" : "tests"}. Review and
        save in the editor.
      </p>
    );
  return (
    <section
      className="mx-4 space-y-3 rounded-lg border border-border bg-card p-4 text-card-foreground"
      aria-label="Test proposal"
    >
      <p className="text-sm">{proposal.summary}</p>
      {count > 1 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {proposal.cases.map((draft, index) => (
            <li key={index}>{draft.title}</li>
          ))}
        </ol>
      )}
      <Button
        className="h-auto w-full whitespace-normal"
        disabled={busy || !contextReady}
        onClick={() => {
          setError(undefined);
          try {
            createDescribeCases(sessionId, scope, proposal.id);
            if (window.matchMedia?.("(max-width: 1023px)").matches)
              useAgentPanelStore.getState().setOpen(false);
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not create tests. Try again.",
            );
          }
        }}
      >
        Create {count} {count === 1 ? "test" : "tests"} for {proposal.subject}
      </Button>
      {!contextReady && (
        <p role="status" className="text-xs text-muted-foreground">
          Waiting for the case and tools to be ready.
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Creates editable drafts. Your suite changes when you save.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
