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
import type { EvaluateNavCrumb } from "../nav/evaluate-nav-breadcrumbs";

/** The trail `buildEvaluateNavCrumbs` built; every crumb but the last is a link. */
export function EvaluateNavCrumbBar({
  crumbs,
  onNavigate,
  actions,
}: {
  crumbs: readonly EvaluateNavCrumb[];
  onNavigate: (route: EvalRoute) => void;
  actions?: ReactNode;
}) {
  return (
    <div className={PAGE_HEADER_STRIP_CLASSNAME} data-testid="evals-header">
      <Breadcrumb className="min-w-0">
        <BreadcrumbList className="min-w-0 flex-nowrap">
          {crumbs.map((crumb, index) => {
            const isLast = index === crumbs.length - 1;
            return (
              <Fragment key={`${crumb.kind}-${index}`}>
                {index > 0 && (
                  <BreadcrumbSeparator className="text-muted-foreground">
                    /
                  </BreadcrumbSeparator>
                )}
                <BreadcrumbItem className="max-w-[min(240px,40vw)] min-w-0">
                  {isLast ? (
                    <BreadcrumbPage className="truncate">
                      {crumb.label}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink asChild>
                      <button
                        type="button"
                        onClick={() => onNavigate(crumb.route)}
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
      {actions}
    </div>
  );
}
