import type { ReactNode } from "react";
import { ChevronDown, Play, Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import { type ViewModeSelectorOption } from "@/components/shared/view-mode-selector";
import {
  LandingPageHeader,
  PAGE_HEADER_STRIP_CLASSNAME,
} from "@/components/shared/landing-page-header";

import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@mcpjam/design-system/dropdown-menu";

const EVALUATE_HEADER_DESCRIPTION =
  "Build a durable test suite from the prompts you already run by hand and automatically measure performance over time.";

export const EVAL_LANDING_VIEW_OPTIONS = [
  { value: "runs", label: "Overview" },
  { value: "suites", label: "Suites" },
] as const satisfies readonly ViewModeSelectorOption<"suites" | "runs">[];

export type EvalLandingView =
  (typeof EVAL_LANDING_VIEW_OPTIONS)[number]["value"];

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
  onSetupRun,
  onAddCase,
  children,
  parentCrumb,
  detailCrumb,
  onCurrentCrumbClick,
  landingView,
  onLandingViewChange,
  onEvaluateClick,
  isDetail: isDetailProp,
}: {
  onCreateSuite?: () => void;
  onSetupRun?: () => void;
  onAddCase?: () => void;
  children?: ReactNode;
  parentCrumb?: EvalsHeaderParentCrumb;
  detailCrumb?: { label: string; onClick?: () => void };
  onCurrentCrumbClick?: () => void;
  landingView?: EvalLandingView;
  onLandingViewChange?: (view: EvalLandingView) => void;
  onEvaluateClick?: () => void;
  /** When set, forces detail chrome even if the last crumb has not loaded. */
  isDetail?: boolean;
}) {
  const isDetail = isDetailProp ?? Boolean(children || parentCrumb);

  if (isDetail) {
    return (
      <div className={PAGE_HEADER_STRIP_CLASSNAME} data-testid="evals-header">
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
                {onCurrentCrumbClick ? (
                  <BreadcrumbLink asChild>
                    <button
                      type="button"
                      onClick={onCurrentCrumbClick}
                      className="truncate"
                    >
                      {children}
                    </button>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage className="truncate">
                    {children}
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            ) : null}
            {detailCrumb ? (
              <>
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem>
                  {detailCrumb.onClick ? (
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={detailCrumb.onClick}>
                        {detailCrumb.label}
                      </button>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{detailCrumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </>
            ) : null}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    );
  }

  const showLandingTabs = landingView != null && onLandingViewChange != null;

  return (
    <LandingPageHeader
      testId="evals-header"
      title="Evaluate"
      description={EVALUATE_HEADER_DESCRIPTION}
      tabs={
        showLandingTabs
          ? {
              value: landingView,
              options: EVAL_LANDING_VIEW_OPTIONS,
              onChange: onLandingViewChange,
              ariaLabel: "Evaluate view",
              indicatorId: "evals-landing",
            }
          : undefined
      }
      actions={
        landingView != null && onSetupRun && onCreateSuite ? (
          <div className="inline-flex shrink-0 items-center">
            <Button
              size="sm"
              className="gap-1.5 rounded-r-none"
              onClick={landingView === "runs" ? onSetupRun : onCreateSuite}
            >
              {landingView === "runs" ? (
                <Play className="h-4 w-4" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              {landingView === "runs" ? "Setup Run" : "Create suite"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="rounded-l-none border-l border-primary-foreground/30 px-2"
                  aria-label="More evaluate actions"
                >
                  <ChevronDown className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {landingView === "runs" && onCreateSuite && (
                  <DropdownMenuItem onSelect={onCreateSuite}>
                    <Plus className="h-4 w-4" />
                    Create suite
                  </DropdownMenuItem>
                )}
                {/* Each landing offers ONE alternative to its primary
                    action, and it is the other landing's subject. Runs
                    does not offer a case: a case belongs to a suite, and
                    the runs list never names one. */}
                {landingView === "suites" && onAddCase && (
                  <DropdownMenuItem onSelect={onAddCase}>
                    <Plus className="h-4 w-4" />
                    Add test case
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : onCreateSuite ? (
          <Button
            type="button"
            size="sm"
            className="shrink-0 gap-1.5"
            onClick={onCreateSuite}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create suite
          </Button>
        ) : null
      }
    />
  );
}
