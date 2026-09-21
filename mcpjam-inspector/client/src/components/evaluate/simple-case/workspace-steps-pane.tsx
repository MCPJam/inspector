import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

/**
 * The deep step list inside the case workspace.
 *
 * "Steps" used to swap the whole page for the old editor, and nothing brought
 * the author back until they switched cases — a one-way door out of the only
 * chrome the surface has. Here it is one column of the same workspace, with
 * the trial still on the right and a way back.
 */
export function WorkspaceStepsPane({
  header,
  onBackToForm,
  children,
}: {
  header?: ReactNode;
  onBackToForm: () => void;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4" data-testid="case-workspace-steps-pane">
      {header}
      <div className="flex items-center justify-start">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs text-muted-foreground"
          onClick={onBackToForm}
          data-testid="case-workspace-back-to-form"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back to form
        </Button>
      </div>
      {children}
    </div>
  );
}
