/**
 * The Suite run page's Back button. It returns to the page the user came
 * from, which that page names in router state, and to the suite otherwise
 * (a direct load or a shared link). The breadcrumb is built from the route;
 * Back is the one control that depends on how the user arrived.
 */
import { useContext } from "react";
import { UNSAFE_LocationContext, UNSAFE_NavigationContext } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { EvalRoute } from "@/lib/eval-route-types";
import {
  buildEvaluatePath,
  navigateApp,
  scopeNavigationTarget,
} from "@/lib/app-navigation";
import { EVAL_NAV_ARRIVAL_STATE_KEY } from "./evaluate-nav-host";

/** Router state key a page sets when it links here, to be Back's target. */
export const EVAL_NAV_BACK_STATE_KEY = "evalNavBack";

/**
 * Where Back leads: an app path (from `buildEvaluatePath`) and the place name
 * its label uses, as in "Back to {place}".
 */
export interface EvalNavBackTarget {
  path: string;
  place: string;
}

/** Router state for a link into a page with Back, naming the page it left. */
export function evalNavBackState(route: EvalRoute, place: string) {
  return {
    [EVAL_NAV_BACK_STATE_KEY]: { path: buildEvaluatePath(route), place },
  };
}

export function readBackTarget(state: unknown): EvalNavBackTarget | null {
  if (typeof state !== "object" || state === null) return null;
  const value: unknown = Reflect.get(state, EVAL_NAV_BACK_STATE_KEY);
  if (typeof value !== "object" || value === null) return null;
  const path: unknown = Reflect.get(value, "path");
  const place: unknown = Reflect.get(value, "place");
  if (typeof place !== "string" || !place) return null;
  // App-relative paths only: state must never send Back off the app.
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  )
    return null;
  return { path, place };
}

export function SuiteRunBackButton({ suiteId }: { suiteId: string }) {
  const navigator = useContext(UNSAFE_NavigationContext)?.navigator;
  const location = useContext(UNSAFE_LocationContext)?.location;
  const target = readBackTarget(location?.state) ?? {
    path: buildEvaluatePath({ type: "suite-overview", suiteId }),
    place: "suite",
  };
  const label = `Back to ${target.place}`;

  const goBack = () => {
    const path = scopeNavigationTarget(target.path, location?.pathname);
    if (!navigator) {
      navigateApp(path);
      return;
    }
    navigator.push(path, { [EVAL_NAV_ARRIVAL_STATE_KEY]: "back" });
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8 shrink-0 gap-1.5 px-2.5"
      title={label}
      aria-label={label}
      data-testid="suite-run-back"
      onClick={goBack}
    >
      <ArrowLeft className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">{label}</span>
      <span className="sm:hidden">Back</span>
    </Button>
  );
}
