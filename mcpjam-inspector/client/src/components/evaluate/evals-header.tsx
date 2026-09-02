import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  ViewModeSelector,
  type ViewModeSelectorOption,
} from "@/components/shared/view-mode-selector";
import { cn } from "@/lib/utils";

export const EVAL_LANDING_VIEW_OPTIONS = [
  { value: "suites", label: "Suites" },
  { value: "runs", label: "Runs" },
] as const satisfies readonly ViewModeSelectorOption<"suites" | "runs">[];

export type EvalLandingView = (typeof EVAL_LANDING_VIEW_OPTIONS)[number]["value"];

const TAB_CLASSNAME =
  "shrink-0 justify-start overflow-x-visible [&_button]:min-h-9 [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-sm sm:[&_button]:min-h-9 sm:[&_button]:px-3.5 sm:[&_button]:text-sm md:[&_button]:min-h-9 lg:[&_button]:px-4";

/**
 * Evaluate (New) header — one compact row on every route:
 * Suites | Runs on the left, suite navigation in the center, New suite on the right.
 */
export function EvalsHeader({
  onCreateSuite,
  children,
  landingView,
  onLandingViewChange,
  showLandingIntro = false,
}: {
  onCreateSuite?: () => void;
  children?: ReactNode;
  landingView?: EvalLandingView;
  onLandingViewChange?: (view: EvalLandingView) => void;
  /** Optional title block below the nav row on the suites landing only. */
  showLandingIntro?: boolean;
}) {
  const showTabs =
    landingView != null && onLandingViewChange != null;

  return (
    <div
      className="relative shrink-0 border-b border-border bg-muted/40 px-4 sm:px-6"
      data-testid="evals-header"
    >
      <div className="flex min-w-0 items-center gap-3 py-2.5 sm:gap-4">
        {showTabs ? (
          <ViewModeSelector
            value={landingView}
            options={EVAL_LANDING_VIEW_OPTIONS}
            onChange={onLandingViewChange}
            ariaLabel="Evaluate view"
            indicatorId="evals-landing"
            className={TAB_CLASSNAME}
          />
        ) : null}
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
      {showLandingIntro ? (
        <div className={cn("pb-4 pt-1")}>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">
            Evaluate
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            We generate cases from live discovery, or describe behaviors in chat,
            or import your existing tests.
          </p>
        </div>
      ) : null}
    </div>
  );
}
