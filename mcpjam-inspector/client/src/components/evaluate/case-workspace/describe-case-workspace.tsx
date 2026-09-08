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
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden "
      data-testid="describe-case-workspace"
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <div className="mx-auto w-full max-w-5xl">
          <div className="rounded-xl border border-card-foreground/50 bg-card text-card-foreground">
            <div className="flex items-center gap-3 px-5 pt-4 pb-2">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Draft
              </span>
              <input
                value={title}
                onChange={(event) => onTitleChange(event.target.value)}
                aria-label="Draft case title"
                className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground outline-none placeholder:text-muted-foreground"
                placeholder="Untitled test case"
              />
              <span className="hidden text-[10px] text-muted-foreground sm:inline">
                Every field is editable
              </span>
            </div>
            <div className="px-5 py-5 sm:px-6">{caseForm}</div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onAsk}>
              Ask MCPJam
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onSave}
              disabled={saveDisabled}
            >
              Save case
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
