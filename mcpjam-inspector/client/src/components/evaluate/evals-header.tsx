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

const EVALUATE_HEADER_DESCRIPTION =
  "The manual pass you'd do before a ship, automated and run whenever the server changes.";

export const EVAL_LANDING_VIEW_OPTIONS = [
  { value: "suites", label: "Suites" },
  { value: "runs", label: "Runs" },
] as const satisfies readonly ViewModeSelectorOption<"suites" | "runs">[];

export type EvalLandingView = (typeof EVAL_LANDING_VIEW_OPTIONS)[number]["value"];

// Same tab chrome as Swarm — title | tabs on one baseline.
const TAB_CLASSNAME =
  "mt-0 w-auto min-w-0 shrink justify-start overflow-x-auto [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm sm:[&_button]:min-h-8 sm:[&_button]:px-3 sm:[&_button]:text-sm md:[&_button]:min-h-8 lg:[&_button]:px-3.5";

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
      className="relative shrink-0 border-b border-border/40 px-4 py-4 sm:px-6"
      data-testid="evals-header"
    >
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
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div
              className="flex min-w-0 items-center gap-3"
              data-testid="evals-header-title-row"
            >
              <h1 className="shrink-0 text-xl font-bold tracking-tight text-foreground">
                Evaluate
              </h1>
              {showLandingTabs ? (
                <>
                  <div
                    className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
                    aria-hidden="true"
                    data-testid="evals-header-title-rule"
                  />
                  <ViewModeSelector
                    value={landingView}
                    options={EVAL_LANDING_VIEW_OPTIONS}
                    onChange={onLandingViewChange}
                    ariaLabel="Evaluate view"
                    indicatorId="evals-landing"
                    className={TAB_CLASSNAME}
                  />
                </>
              ) : null}
            </div>
            {onCreateSuite ? (
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
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            {EVALUATE_HEADER_DESCRIPTION}
          </p>
        </>
      )}
    </div>
  );
}
