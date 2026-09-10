import { EvalGeneratedDrafts } from "../eval-generated-drafts";
import { useDescribeSurface } from "@/lib/mcpjam-agent/describe-surface";
import { useDescribeFlow } from "@/lib/mcpjam-agent/describe-flow";
import { MessageCircle } from "lucide-react";
import { useAgentPanelStore } from "@/stores/agent-panel/agent-panel-store";
import type { ReactNode } from "react";
import { Button } from "@mcpjam/design-system/button";

export function DescribeCaseWorkspace({
  title,
  onTitleChange,
  caseForm,
  onAsk,
  onSave,
  saveDisabled,
}: {
  title: string;
  onTitleChange: (title: string) => void;
  caseForm: ReactNode;
  onAsk: () => void;
  onSave: () => void;
  saveDisabled: boolean;
}) {
  const scope = useDescribeSurface((s) => s.scope);
  const sessionId = useAgentPanelStore((s) => s.activeSessionId);
  const flow = useDescribeFlow((s) =>
    sessionId ? s.sessions[sessionId] : undefined,
  );
  const batch = !!flow?.createdIds?.length;
  const chatOpen = useAgentPanelStore((state) => state.isOpen);
  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden "
      data-testid="describe-case-workspace"
      data-describe-guiding={
        chatOpen && flow?.phase !== "reviewing" ? "true" : undefined
      }
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 pb-24 sm:px-6 lg:px-8 lg:py-8 lg:pb-24">
        <div className="mx-auto w-full max-w-5xl">
          {batch && scope ? (
            <EvalGeneratedDrafts
              projectId={scope.projectId}
              suiteId={scope.suiteId}
              suiteName={scope.suiteName}
              visibleDraftIds={new Set(flow?.createdIds)}
              hideChat
              saveVisibleOnly
            />
          ) : (
            <>
              <div className="rounded-xl border border-card-foreground/50 bg-card text-card-foreground">
                <div className="flex items-center gap-3 px-5 pt-4 pb-2">
                  <input
                    value={title}
                    onChange={(event) => onTitleChange(event.target.value)}
                    aria-label="Draft case title"
                    className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground outline-none placeholder:text-muted-foreground"
                    placeholder="Untitled test case"
                  />
                </div>
                <div className="px-5 py-5 sm:px-6">{caseForm}</div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={onSave}
                  disabled={saveDisabled}
                >
                  Save case
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
      {!chatOpen ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onAsk}
          aria-label="Ask MCPJam"
          title="Ask MCPJam"
          className="absolute bottom-5 right-5 z-20 size-12 rounded-full border-border bg-popover text-popover-foreground shadow-sm"
        >
          <MessageCircle className="size-5" />
        </Button>
      ) : null}
    </div>
  );
}
