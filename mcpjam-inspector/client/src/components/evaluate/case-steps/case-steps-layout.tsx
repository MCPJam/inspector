/**
 * Where the crumb bar, title row, execution preview and editor sit on the
 * editor's two kinds of page. The preview docks on the left; the title row
 * keeps its place whether it is open or closed.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type LayoutProps = {
  crumbBar: ReactNode;
  header: ReactNode;
  /** The docked preview, or null while it is closed. */
  panel: ReactNode;
  children: ReactNode;
};

/** New case: one scrolling page; the preview stacks above the body below md. */
export function NewCaseLayout({
  crumbBar,
  header,
  panel,
  children,
}: LayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {crumbBar}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-6 sm:px-6">
        <div className="mx-auto w-full max-w-6xl space-y-5 pb-24">
          {header}
          <div className="flex flex-col gap-5 md:flex-row">
            {panel}
            <div
              className={cn(
                "min-w-0 flex-1 space-y-5",
                !panel && "mx-auto max-w-4xl",
              )}
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Test case: a fixed header row; the preview sits beside the scrolling editor, sized to that pane. */
export function CaseLayout({ crumbBar, header, panel, children }: LayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {crumbBar}
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-6 sm:px-6">
        {header}
        <div className="flex min-h-0 flex-1 gap-4">
          {panel ? <div className="flex min-h-0 pt-4">{panel}</div> : null}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-4xl flex-col gap-5 px-6 py-6">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
