/**
 * The case pages' header: the route-built breadcrumb with Back on the right,
 * then the page title and its actions.
 */

import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { EvalRoute } from "@/lib/eval-route-types";
import type { EvaluateNavCrumbNames } from "../nav/evaluate-nav-breadcrumbs";
import { EvaluateNavCrumbBar } from "../nav/evaluate-nav-crumb-bar";
import { useEvaluateNavNavigate } from "../nav/use-evaluate-nav-navigate";

export function CasePageHeader({
  route,
  names,
  back,
  title,
  actions,
}: {
  route: EvalRoute;
  names: EvaluateNavCrumbNames;
  back: { label: string; route: EvalRoute };
  title: ReactNode;
  actions?: ReactNode;
}) {
  const navigate = useEvaluateNavNavigate();
  return (
    <header className="shrink-0" data-testid="case-page-header">
      <EvaluateNavCrumbBar
        route={route}
        names={names}
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => navigate(back.route, "back")}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {back.label}
          </Button>
        }
      />
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
