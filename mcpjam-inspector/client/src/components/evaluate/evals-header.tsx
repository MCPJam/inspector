import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import {
  ViewModeSelector,
  type ViewModeSelectorOption,
} from "@/components/shared/view-mode-selector";
import { cn } from "@/lib/utils";

const EVALUATE_HEADER_DESCRIPTION =
  "We generate cases from live discovery, or describe behaviors in chat, or import your existing tests.";

export const EVAL_LANDING_VIEW_OPTIONS = [
  { value: "suites", label: "Suites" },
  { value: "runs", label: "Runs" },
] as const satisfies readonly ViewModeSelectorOption<"suites" | "runs">[];

export type EvalLandingView = (typeof EVAL_LANDING_VIEW_OPTIONS)[number]["value"];

// Same tab chrome as swarm run Insights / Sessions (DetailPageHeader).
const TAB_CLASSNAME =
  "-ml-3 justify-start overflow-x-visible md:w-auto [&_button]:min-h-9 [&_button]:px-3 [&_button]:py-1.5 [&_button]:text-sm sm:[&_button]:min-h-9 sm:[&_button]:px-3.5 sm:[&_button]:text-sm md:[&_button]:min-h-9 lg:[&_button]:px-4";

export type EvalsHeaderParentCrumb = {
  label: string;
  onClick: () => void;
};

/**
 * The Evaluate page header. Landing shows the title, description, Create
 * suite, and Suites | Runs tabs. Detail routes replace that chrome with a
 * trail: Evaluate / current page, or Evaluate / suite / current page when
 * drilled into a case or run.
 */
export function EvalsHeader({
  onCreateSuite,
  children,
  parentCrumb,
  landingView,
  onLandingViewChange,
  onEvaluateClick,
  isDetail: isDetailProp,
}: {
  onCreateSuite?: () => void;
  children?: ReactNode;
  parentCrumb?: EvalsHeaderParentCrumb;
  landingView?: EvalLandingView;
  onLandingViewChange?: (view: EvalLandingView) => void;
  onEvaluateClick?: () => void;
  /** When set, forces detail chrome even if the last crumb has not loaded. */
  isDetail?: boolean;
}) {
  const isDetail = isDetailProp ?? Boolean(children || parentCrumb);
  const showLandingTabs =
    !isDetail && landingView != null && onLandingViewChange != null;

  return (
    <div
      className={cn(
        "relative shrink-0 border-b border-border bg-muted/40 px-4 sm:px-6",
        showLandingTabs ? "pt-4 pb-0" : "py-4",
      )}
      data-testid="evals-header"
    >
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="min-w-0 flex-1">
          {isDetail ? (
            <Breadcrumb className="min-w-0">
              <BreadcrumbList className="min-w-0 flex-nowrap">
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      onClick={onEvaluateClick}
                      className="inline-flex border-0 bg-transparent p-0 font-normal text-muted-foreground hover:text-foreground"
                    >
                      Evaluate
                    </button>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                {/* Both crumbs below are conditional — a detail route whose
                    title has not resolved yet (the header renders outside the
                    details spinner) would otherwise read "Evaluate /". */}
                {parentCrumb || children ? (
                  <BreadcrumbSeparator className="text-muted-foreground">
                    /
                  </BreadcrumbSeparator>
                ) : null}
                {parentCrumb ? (
                  <>
                    <BreadcrumbItem className="max-w-[min(200px,40vw)] min-w-0">
                      <BreadcrumbLink asChild>
                        <button
                          type="button"
                          onClick={parentCrumb.onClick}
                          className="inline-flex min-w-0 border-0 bg-transparent p-0 font-normal text-muted-foreground hover:text-foreground"
                        >
                          <span className="truncate">{parentCrumb.label}</span>
                        </button>
                      </BreadcrumbLink>
                    </BreadcrumbItem>
                    <BreadcrumbSeparator className="text-muted-foreground">
                      /
                    </BreadcrumbSeparator>
                  </>
                ) : null}
                {children ? (
                  <BreadcrumbItem className="max-w-[min(280px,50vw)] min-w-0">
                    <BreadcrumbPage className="truncate font-semibold text-foreground">
                      {children}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                ) : null}
              </BreadcrumbList>
            </Breadcrumb>
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-tight text-foreground">
                Evaluate
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {EVALUATE_HEADER_DESCRIPTION}
              </p>
            </>
          )}
        </div>
        {!isDetail && onCreateSuite ? (
          <Button
            type="button"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={onCreateSuite}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create suite
          </Button>
        ) : null}
      </div>
      {showLandingTabs ? (
        <ViewModeSelector
          value={landingView}
          options={EVAL_LANDING_VIEW_OPTIONS}
          onChange={onLandingViewChange}
          ariaLabel="Evaluate view"
          indicatorId="evals-landing"
          className={TAB_CLASSNAME}
        />
      ) : null}
    </div>
  );
}
