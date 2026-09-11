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
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden"
      data-testid="case-workspace"
    >
      <div className="relative flex min-h-0 w-full shrink-0 flex-col border-b border-border md:w-[56%] md:border-b-0 md:border-r">
        <div className="flex min-h-0 flex-1 flex-col gap-5 px-6 py-6 md:overflow-y-auto md:overscroll-y-contain md:px-7">
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/10">
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
  );
}
