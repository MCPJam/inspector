import { Fragment, type ReactNode } from "react";
import {
  ArrowLeft,
  ChevronDown,
  EllipsisVertical,
  GraduationCap,
  Play,
  Plus,
} from "lucide-react";
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
import { useAppNavigate } from "@/lib/app-navigation";
import { cn } from "@/lib/utils";
import type { EvalBack, EvalCrumb } from "./nav/eval-nav-crumbs";
import {
  useEvalNavigate,
  type EvalNavLocationState,
} from "./nav/eval-nav-state";

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
  detailCrumb?:
    | { label: string; onClick?: () => void }
    | readonly { label: string; onClick?: () => void }[];
  onCurrentCrumbClick?: () => void;
  landingView?: EvalLandingView;
  onLandingViewChange?: (view: EvalLandingView) => void;
  onEvaluateClick?: () => void;
  /** When set, forces detail chrome even if the last crumb has not loaded. */
  isDetail?: boolean;
}) {
  const isDetail = isDetailProp ?? Boolean(children || parentCrumb);
  const detailCrumbs = detailCrumb
    ? Array.isArray(detailCrumb)
      ? detailCrumb
      : [detailCrumb]
    : [];

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
            {detailCrumbs.map((crumb) => (
              <span key={crumb.label} className="contents">
                <BreadcrumbSeparator>/</BreadcrumbSeparator>
                <BreadcrumbItem>
                  {crumb.onClick ? (
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={crumb.onClick}>
                        {crumb.label}
                      </button>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </span>
            ))}
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

export interface EvalCrumbBarProps {
  /** buildEvalCrumbs(route, names) output, unchanged. Callers pass `?? []` for null. */
  crumbs: readonly EvalCrumb[];
  /** buildEvalBack(route, names, useEvalNavArrival().from) output. null/absent: no Back. */
  back?: EvalBack | null;
  /** Buttons that live in the bar, left of Back. */
  actions?: ReactNode;
}

const BACK_STATE: EvalNavLocationState = { evalNav: { via: "back" } };

/**
 * The strip at the top of every per-layer Evaluate page: breadcrumbs, then the
 * page's own bar actions, then Back. Same height and inset as the landing
 * header. A crumb with `to` pushes it with via "crumb"; Back pushes back.path.
 * On a phone a trail longer than three keeps the first and the last two and
 * folds the rest into "…".
 */
export function EvalCrumbBar({ crumbs, back, actions }: EvalCrumbBarProps) {
  const navigateEval = useEvalNavigate();
  const navigate = useAppNavigate();
  const last = crumbs.length - 1;
  const folds = crumbs.length > 3;
  const folded = (index: number) => folds && index > 0 && index < last - 1;

  return (
    <div
      className={cn(PAGE_HEADER_STRIP_CLASSNAME, "flex items-center gap-3")}
      data-testid="evals-header"
    >
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="min-w-0 flex-nowrap">
          {crumbs.map((crumb, index) => {
            const busy = crumb.pending ? true : undefined;
            const to = index === last ? undefined : crumb.to;
            return (
              <Fragment key={index}>
                {index === 1 && folds ? (
                  <>
                    <BreadcrumbSeparator className="shrink-0 sm:hidden">
                      /
                    </BreadcrumbSeparator>
                    <li aria-hidden="true" className="shrink-0 sm:hidden">
                      …
                    </li>
                  </>
                ) : null}
                {index > 0 ? (
                  <BreadcrumbSeparator
                    className={cn(
                      "shrink-0",
                      folded(index) && "hidden sm:inline",
                    )}
                  >
                    /
                  </BreadcrumbSeparator>
                ) : null}
                <BreadcrumbItem
                  className={cn(
                    "min-w-0",
                    folded(index) && "hidden sm:inline-flex",
                    index === 0
                      ? "shrink-[0.5] sm:shrink-0"
                      : index === last
                        ? "shrink"
                        : "max-w-48 shrink",
                  )}
                >
                  {to ? (
                    <BreadcrumbLink asChild>
                      <button
                        type="button"
                        aria-busy={busy}
                        onClick={() => navigateEval(to, { via: "crumb" })}
                        className="inline-flex min-w-0 border-0 bg-transparent p-0 font-normal text-muted-foreground hover:text-foreground"
                      >
                        <span className="truncate">{crumb.label}</span>
                      </button>
                    </BreadcrumbLink>
                  ) : (
                    <BreadcrumbPage className="truncate" aria-busy={busy}>
                      {crumb.label}
                    </BreadcrumbPage>
                  )}
                </BreadcrumbItem>
              </Fragment>
            );
          })}
        </BreadcrumbList>
      </Breadcrumb>
      {actions}
      {back ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-8 shrink-0 gap-1.5 px-2.5"
          title={back.label}
          onClick={() => navigate(back.path, { state: BACK_STATE })}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          <span className="hidden sm:inline">{back.label}</span>
          <span className="sm:hidden">Back</span>
        </Button>
      ) : null}
    </div>
  );
}

/** The landing's two tabs, each an address: list = /evaluate, evaluate-runs = /evaluate/runs. */
export type EvalNavLandingTab = "suites" | "runs";

export const EVAL_NAV_LANDING_TABS = [
  { value: "suites", label: "Suites" },
  { value: "runs", label: "Runs" },
] as const satisfies readonly ViewModeSelectorOption<EvalNavLandingTab>[];

export interface EvalNavLandingHeaderProps {
  tab: EvalNavLandingTab;
  onTabChange: (tab: EvalNavLandingTab) => void;
  onCreateSuite: () => void;
  /** ⋮ › Tutorial. */
  onOpenTutorial: () => void;
}

/** The Evaluate landing header with the flag on: Suites | Runs, Create suite and ⋮ › Tutorial. */
export function EvalNavLandingHeader({
  tab,
  onTabChange,
  onCreateSuite,
  onOpenTutorial,
}: EvalNavLandingHeaderProps) {
  return (
    <LandingPageHeader
      testId="evals-header"
      title="Evaluate"
      description={EVALUATE_HEADER_DESCRIPTION}
      tabs={{
        value: tab,
        options: EVAL_NAV_LANDING_TABS,
        onChange: onTabChange,
        ariaLabel: "Evaluate view",
        indicatorId: "evals-landing",
      }}
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            onClick={onCreateSuite}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Create suite
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 data-[state=open]:bg-chrome-hover"
                aria-label="More options"
                title="More options"
              >
                <EllipsisVertical className="size-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onOpenTutorial}>
                <GraduationCap aria-hidden />
                Tutorial
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      }
    />
  );
}
