/**
 * CasePreviewPane — the editor's right pane. A `Preview | Runs` toggle (mirrors
 * the Chatboxes Preview/Host-graph switch) over two caller-provided slots:
 *   • Preview — the forming conversation (edit-time spec, later live/replay).
 *   • Runs    — run history for this case.
 *
 * Controlled: the parent (`TestTemplateEditor`) owns `tab` so route deep-links
 * (openCompare) and run-completion can drive it, and clicking a run can flip
 * the pane back to Preview for replay.
 */
import { useState, type ReactNode } from "react";
import { MessagesSquare, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { PreviewHeaderSlotProvider } from "./preview-header-slot";

export type CasePreviewTab = "preview" | "runs";

export function CasePreviewPane({
  tab,
  onTabChange,
  previewSlot,
  runsSlot,
  runsCount,
  runsDotClass,
  previewStatusSlot,
  previewToolbarSlot,
}: {
  tab: CasePreviewTab;
  onTabChange: (tab: CasePreviewTab) => void;
  previewSlot: ReactNode;
  runsSlot: ReactNode;
  runsCount?: number;
  runsDotClass?: string;
  /** Right-aligned status (e.g. the live Quick Run verdict). Shown on Preview. */
  previewStatusSlot?: ReactNode;
  /** Second header row (trace tabs, run status, retry). Rendered inside the header chrome. */
  previewToolbarSlot?: ReactNode;
}) {
  const tabButtonClass = (active: boolean) =>
    cn(
      "inline-flex min-h-7 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
      active
        ? "bg-background text-foreground ring-1 ring-inset ring-border/60"
        : "text-muted-foreground hover:bg-background/50 hover:text-foreground",
    );

  const showPreviewToolbar = tab === "preview" && previewToolbarSlot;
  const [hoistedToolbarSlot, setHoistedToolbarSlot] = useState<ReactNode>(null);
  const resolvedPreviewToolbar = previewToolbarSlot ?? hoistedToolbarSlot;
  const showResolvedPreviewToolbar =
    tab === "preview" && resolvedPreviewToolbar != null;

  return (
    <PreviewHeaderSlotProvider onSlotChange={setHoistedToolbarSlot}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-muted/10">
        <header className="relative z-10 shrink-0 border-b border-border/60 bg-muted/10">
          <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2">
          <div
            className="inline-flex items-center gap-0.5 rounded-lg border border-border/50 bg-muted/30 p-0.5"
            role="tablist"
            aria-label="Preview pane"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === "preview"}
              onClick={() => onTabChange("preview")}
              className={tabButtonClass(tab === "preview")}
            >
              <MessagesSquare className="h-3.5 w-3.5 shrink-0" />
              Result
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "runs"}
              onClick={() => onTabChange("runs")}
              className={tabButtonClass(tab === "runs")}
            >
              <History className="h-3.5 w-3.5 shrink-0" />
              Runs
              {runsCount ? (
                <span className="rounded-full bg-muted px-1.5 py-px text-[10px] font-medium tabular-nums text-muted-foreground">
                  {runsCount}
                </span>
              ) : runsDotClass ? (
                <span className={runsDotClass} />
              ) : null}
            </button>
          </div>
          {tab === "preview" && previewStatusSlot ? (
            <div className="flex items-center">{previewStatusSlot}</div>
          ) : null}
        </div>
        {showPreviewToolbar ? (
          <div className="px-3 pb-2 pt-1">{previewToolbarSlot}</div>
        ) : showResolvedPreviewToolbar ? (
          <div className="px-3 pb-2 pt-1">{resolvedPreviewToolbar}</div>
        ) : null}
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {tab === "preview" ? previewSlot : runsSlot}
        </div>
      </div>
    </PreviewHeaderSlotProvider>
  );
}
