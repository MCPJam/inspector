/**
 * The case pages' header: the route-built breadcrumb with Back on the right,
 * then the page title and its actions.
 */

import { Fragment, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@mcpjam/design-system/breadcrumb";
import { PAGE_HEADER_STRIP_CLASSNAME } from "@/components/shared/landing-page-header";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildEvaluateNavCrumbs,
  type EvaluateNavCrumbNames,
} from "../nav/evaluate-nav-breadcrumbs";
import type { EvalNavArrival } from "../nav/evaluate-nav-events";

export function CasePageHeader({
  route,
  names,
  back,
  onNavigate,
  title,
  actions,
}: {
  route: EvalRoute;
  names: EvaluateNavCrumbNames;
  back: { label: string; route: EvalRoute };
  onNavigate: (route: EvalRoute, arrival: EvalNavArrival) => void;
  title: ReactNode;
  actions?: ReactNode;
}) {
  const crumbs = buildEvaluateNavCrumbs(route, names);
  return (
    <header className="shrink-0">
      <div
        className={`${PAGE_HEADER_STRIP_CLASSNAME} flex items-center justify-between gap-4`}
        data-testid="case-page-header"
      >
        <Breadcrumb className="min-w-0">
          <BreadcrumbList className="min-w-0 flex-nowrap">
            {crumbs.map((crumb, index) => {
              const isLast = index === crumbs.length - 1;
              return (
                <Fragment key={`${crumb.kind}:${index}`}>
                  {index > 0 ? (
                    <BreadcrumbSeparator className="text-muted-foreground">
                      /
                    </BreadcrumbSeparator>
                  ) : null}
                  <BreadcrumbItem className="max-w-[min(240px,40vw)] min-w-0">
                    {isLast ? (
                      <BreadcrumbPage className="truncate">
                        {crumb.label}
                      </BreadcrumbPage>
                    ) : (
                      <BreadcrumbLink asChild>
                        <button
                          type="button"
                          onClick={() => onNavigate(crumb.route, "crumb")}
                          className="inline-flex min-w-0 border-0 bg-transparent p-0 font-normal text-muted-foreground hover:text-foreground"
                        >
                          <span className="truncate">{crumb.label}</span>
                        </button>
                      </BreadcrumbLink>
                    )}
                  </BreadcrumbItem>
                </Fragment>
              );
            })}
          </BreadcrumbList>
        </Breadcrumb>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => onNavigate(back.route, "back")}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {back.label}
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}
