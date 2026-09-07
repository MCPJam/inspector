import type { ReactNode } from "react";

/**
 * Evaluate case workspace chrome. Keep this folder free of editor internals.
 */
export function CaseWorkspaceLayout({
  left,
  header,
  evidence,
}: {
  left: ReactNode;
  header: ReactNode;
  evidence: ReactNode;
}) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="case-workspace">
      <div className="flex w-1/2 min-h-0 flex-col gap-5 overflow-y-auto overscroll-y-contain border-r border-border px-4 py-5 sm:px-6">
        {left}
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/10">
        {header}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {evidence}
        </div>
      </div>
    </div>
  );
}
