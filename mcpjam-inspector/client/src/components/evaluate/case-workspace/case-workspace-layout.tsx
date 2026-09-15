import { useState, type ReactNode } from "react";
import { AssertionDrawerContainer } from "../case-spine/assertion-drawer";

/**
 * Evaluate case workspace chrome. Keep this folder free of editor internals.
 */
export function CaseWorkspaceLayout({
  left,
  leftFooter,
  header,
  evidence,
  history,
}: {
  left: ReactNode;
  /** Case-scoped extras below the editor (attachments), not part of authoring. */
  leftFooter?: ReactNode;
  header: ReactNode;
  evidence: ReactNode;
  history?: (evidence: ReactNode) => ReactNode;
}) {
  const [drawerContainer, setDrawerContainer] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto @min-[64rem]:flex-row @min-[64rem]:overflow-hidden"
        data-testid="case-workspace"
      >
        <div className="relative flex min-h-0 w-full shrink-0 flex-col border-b border-border @min-[64rem]:w-[56%] @min-[64rem]:border-b-0 @min-[64rem]:border-r">
          <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-6 @min-[64rem]:overflow-y-auto @min-[64rem]:overscroll-y-contain @min-[64rem]:px-7">
            <AssertionDrawerContainer.Provider value={drawerContainer}>
              {left}
            </AssertionDrawerContainer.Provider>
            {leftFooter}
          </div>
          <div
            ref={setDrawerContainer}
            className="pointer-events-none absolute inset-0 z-40"
          />
        </div>
        <div className="flex min-h-0 min-w-0 shrink-0 flex-col bg-muted/10 @min-[64rem]:flex-1">
          {history ? (
            history(evidence)
          ) : (
            <>
              {header}
              <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                {evidence}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
