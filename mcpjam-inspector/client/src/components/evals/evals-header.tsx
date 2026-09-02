import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { EvalsModeNav } from "./evals-mode-nav";
import type { EvalsMode } from "@/lib/eval-route-url";

/**
 * The Evaluate header strip, shared by both modes.
 *
 * One row: Suites | Runs on the left, suite navigation in the center (`children`),
 * New suite pinned on the right. Detail routes pass a suite switcher (and optional
 * nested trail) as `children` instead of a breadcrumb that repeats the suite name.
 */
export function EvalsHeader({
  mode,
  children,
  onCreateSuite,
}: {
  mode: EvalsMode;
  children?: ReactNode;
  onCreateSuite?: () => void;
}) {
  return (
    <div
      className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 sm:px-6"
      data-testid="evals-header"
    >
      <div className="flex min-w-0 items-center gap-3 sm:gap-4">
        <EvalsModeNav mode={mode} />
        {children ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            {children}
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {onCreateSuite ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0 gap-1.5"
            onClick={onCreateSuite}
          >
            <Plus className="h-4 w-4" aria-hidden />
            New suite
          </Button>
        ) : null}
      </div>
    </div>
  );
}
