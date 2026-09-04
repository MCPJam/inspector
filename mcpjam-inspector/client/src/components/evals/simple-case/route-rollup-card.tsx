import { Button } from "@mcpjam/design-system/button";
import {
  NO_TOOL_PATH_KEY,
  PATH_SEPARATOR,
} from "../../../../../../sdk/src/tool-path";
import type { RouteRollup } from "./route-rollup";

export type RouteRollupCardProps = {
  rollup: RouteRollup;
  expectedPathKey?: string;
  onAdoptTrialRoute?: () => void;
  adoptPrimary?: boolean;
};

function formatPath(pathKey: string): string {
  if (pathKey === NO_TOOL_PATH_KEY) return "no tools";
  return pathKey.split(PATH_SEPARATOR).join(` ${PATH_SEPARATOR} `);
}

export function RouteRollupCard({
  rollup,
  expectedPathKey,
  onAdoptTrialRoute,
  adoptPrimary = false,
}: RouteRollupCardProps) {
  if (rollup.total < 2) return null;
  const top = rollup.routes[0];
  return (
    <div
      className="space-y-2 rounded-md border border-border bg-muted/20 p-3"
      data-testid="route-rollup-card"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-medium text-foreground">
            Across {rollup.total} trials
          </p>
          {top ? (
            <p className="text-[11px] text-muted-foreground">
              same route in {top.count} of {rollup.total}
            </p>
          ) : null}
        </div>
        <span className="rounded-md border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
          Observational
        </span>
      </div>
      {expectedPathKey ? (
        <p className="text-[11px] text-muted-foreground">
          Expected route: {formatPath(expectedPathKey)}
        </p>
      ) : null}
      <ul className="space-y-1">
        {rollup.routes.map((route) => (
          <li
            key={route.pathKey}
            className="text-[11px] text-foreground"
            data-testid="route-rollup-row"
          >
            {formatPath(route.pathKey)}
            <span className="text-muted-foreground"> · {route.count}</span>
          </li>
        ))}
      </ul>
      {onAdoptTrialRoute ? (
        <Button
          type="button"
          variant={adoptPrimary ? "default" : "outline"}
          size="sm"
          className="h-7 text-xs"
          onClick={onAdoptTrialRoute}
        >
          Use this trial&apos;s route as expected
        </Button>
      ) : null}
    </div>
  );
}
