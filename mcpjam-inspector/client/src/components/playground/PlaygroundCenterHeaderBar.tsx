import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ClientContextHeader } from "@/components/shared/ClientContextHeader";
import {
  TraceViewModeTabs,
  type TraceViewMode,
} from "@/components/evals/trace-view-mode-tabs";
import type { UIType } from "@/lib/mcp-ui/mcp-apps-utils";
import type { ProjectHostContextDraft } from "@/lib/client-config";

/**
 * Playground center header: matches App Builder / ChatTabV2 layout — host preview
 * chrome (`ClientContextHeader`) on the first row and Trace / Chat / Raw
 * (`TraceViewModeTabs`) on a second row. Keeping client controls out of the
 * trace mode segmented control avoids implying "Client" is another trace view.
 */
interface Props {
  showTraceTabs: boolean;
  mode: TraceViewMode;
  onModeChange: (m: TraceViewMode) => void;
  activeProjectId: string | null;
  onSaveHostContext?: (
    projectId: string,
    ctx: ProjectHostContextDraft,
  ) => Promise<void>;
  protocol: UIType | null;
  isMultiModelLayoutMode: boolean;
  trailing?: ReactNode;
  /**
   * Optional leading control rendered at the start of the chrome row,
   * ahead of the `ClientContextHeader` chips. Used by the playground to
   * surface the multi-host picker (Phase 2). Kept generic so future
   * leading controls (e.g. saved-view picker) can slot in here too.
   */
  leading?: ReactNode;
  /**
   * When multi-host compare is active, the lead host's display name.
   * Threads into every chip tooltip ("Editing lead host: <name>") so the
   * user understands the toolbar only edits the lead column.
   */
  leadHostInMultiHost?: string | null;
}

export function PlaygroundCenterHeaderBar({
  showTraceTabs,
  mode,
  onModeChange,
  activeProjectId,
  onSaveHostContext,
  protocol,
  isMultiModelLayoutMode,
  trailing,
  leading,
  leadHostInMultiHost,
}: Props) {
  const chromeRowClass = cn(
    "flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
    showTraceTabs ? "border-b border-border/60 px-3 py-1.5" : "h-11 px-3",
  );

  return (
    <div
      className={cn(
        "@container/playground-header flex min-w-0 w-full shrink-0 flex-col border-b border-border text-xs text-muted-foreground",
        isMultiModelLayoutMode ? "bg-background" : "bg-background/50",
      )}
      data-testid="playground-main-header"
    >
      <div className={chromeRowClass}>
        {leading ? (
          <div className="flex shrink-0 items-center">{leading}</div>
        ) : null}
        <div className="flex min-w-0 flex-1 justify-center overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ClientContextHeader
            activeProjectId={activeProjectId}
            onSaveHostContext={onSaveHostContext}
            protocol={protocol}
            showThemeToggle
            className="w-max max-w-full"
            leadHostInMultiHost={leadHostInMultiHost}
          />
        </div>
        {trailing ? (
          <div className="flex shrink-0 items-center">{trailing}</div>
        ) : null}
      </div>

      {showTraceTabs ? (
        <div
          className="px-3 py-1.5"
          data-testid="playground-trace-view-tabs"
        >
          <TraceViewModeTabs
            layout="fullWidth"
            mode={mode}
            onModeChange={(next) => {
              if (next === "tools") return;
              onModeChange(next);
            }}
            showToolsTab={false}
          />
        </div>
      ) : null}
    </div>
  );
}
