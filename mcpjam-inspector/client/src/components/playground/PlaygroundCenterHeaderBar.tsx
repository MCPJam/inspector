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
}: Props) {
  const chromeRowClass = cn(
    "relative flex min-w-0 items-center justify-center gap-2 text-xs text-muted-foreground",
    showTraceTabs ? "border-b border-border/60 px-3 py-1.5" : "h-11 px-3",
    trailing && "pe-11",
    leading && "ps-11",
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
          <div className="pointer-events-none absolute inset-y-0 start-3 z-10 flex items-center">
            <div className="pointer-events-auto">{leading}</div>
          </div>
        ) : null}
        <div className="flex min-w-0 w-full justify-center overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <ClientContextHeader
            activeProjectId={activeProjectId}
            onSaveHostContext={onSaveHostContext}
            protocol={protocol}
            showThemeToggle
            className="w-max max-w-full"
          />
        </div>
        {trailing ? (
          <div className="pointer-events-none absolute inset-y-0 end-3 z-10 flex items-center">
            <div className="pointer-events-auto">{trailing}</div>
          </div>
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
