import { Fragment, type ReactNode } from "react";
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
} from "./evaluate-nav-breadcrumbs";
import { useEvaluateNavNavigate } from "./use-evaluate-nav-navigate";

/**
 * An Evaluate page's breadcrumb, built from the route alone (E2), with the
 * page's actions on the right of the same bar. Every crumb but the last is a
 * link, followed as a `crumb` arrival.
 */
export function EvaluateNavCrumbBar({
  route,
  names,
  actions,
}: {
  route: EvalRoute;
  names: EvaluateNavCrumbNames;
  actions?: ReactNode;
}) {
  const navigate = useEvaluateNavNavigate();
  const crumbs = buildEvaluateNavCrumbs(route, names);
  return (
    <div
      className={`${PAGE_HEADER_STRIP_CLASSNAME} flex flex-wrap items-center justify-between gap-3`}
      data-testid="evaluate-nav-crumb-bar"
    >
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="min-w-0 flex-nowrap">
          {crumbs.map((crumb, index) => {
            const isCurrent = index === crumbs.length - 1;
            return (
              <Fragment key={`${crumb.kind}:${index}`}>
                {index > 0 ? (
                  <BreadcrumbSeparator className="text-muted-foreground">
                    /
                  </BreadcrumbSeparator>
                ) : null}
                <BreadcrumbItem className="max-w-[min(240px,40vw)] min-w-0">
                  {isCurrent ? (
                    <BreadcrumbPage className="truncate">
                      {crumb.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <button
                        type="button"
                        onClick={() => navigate(crumb.route, "crumb")}
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
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
