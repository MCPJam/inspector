import { useCallback, useEffect, useRef } from "react";
import type { SuiteSettingsRouteTab } from "@/lib/eval-route-types";
import { parseEvalRouteFromUrl } from "@/lib/eval-route-url";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { useEvaluateNavPage } from "../nav/eval-nav-pages";
import { useEvaluateNavEnabled } from "../nav/use-evaluate-nav-enabled";
import { trackEvalNav, type EvalNavArrival } from "../nav/eval-nav-events";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";

/** The suite whose Suite settings page `pathname` names, if it names one. */
function suiteSettingsSuiteId(pathname: string): string | null {
  const route = parseEvalRouteFromUrl("/evaluate", pathname);
  return route?.type === "suite-settings" ? route.suiteId : null;
}

/**
 * Whether a navigation stays on one suite's Suite settings page. Switching
 * tabs keeps the settings draft, so the unsaved-changes guard lets it through.
 */
export function staysInSuiteSettings(
  currentPathname: string,
  nextPathname: string,
): boolean {
  const current = suiteSettingsSuiteId(currentPathname);
  return current !== null && current === suiteSettingsSuiteId(nextPathname);
}

/** The tab that shows a setting, so a "Fix" link can open it. */
function suiteSettingsTabFor(
  key: EvalSuiteSettingKey,
): Exclude<SuiteSettingsRouteTab, "cases"> {
  return key === "passOrFail" ? "evaluators" : "settings";
}

/** In-app navigation leaves a history index above 0; a pasted link does not. */
function firstArrival(): EvalNavArrival {
  const index = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof index === "number" && index > 0 ? "link" : "direct";
}

export type SuiteSettingsNav = {
  /** The open tab while the new Suite settings page shows; null otherwise. */
  tab: SuiteSettingsRouteTab | null;
  /** The address is Suite settings but the flag has not loaded yet. */
  pending: boolean;
  openTab: (tab: SuiteSettingsRouteTab) => void;
  /** For the unsaved-changes guard: tab switches keep the draft. */
  keepsDraft?: (currentPathname: string, nextPathname: string) => boolean;
  /** Opens the tab that shows `key`, then runs `open` to reach the row. */
  fix: (
    key: EvalSuiteSettingKey,
    open: (key: EvalSuiteSettingKey) => void,
  ) => void;
};

/**
 * Suite settings as tabs, read from the address. Only with
 * `evaluate-nav-enabled` on; with it off the address renders today's sheet.
 */
export function useSuiteSettingsNav(suiteId: string): SuiteSettingsNav {
  const { route } = useEvaluateNavPage();
  const enabled = useEvaluateNavEnabled();
  const onPage = route.type === "suite-settings" && route.suiteId === suiteId;
  const tab = onPage && enabled === true ? route.tab : null;

  const viewed = useRef(false);
  useEffect(() => {
    if (!tab) return;
    trackEvalNav("eval_nav_page_viewed", {
      page: "suite-settings",
      tab,
      arrived_via: viewed.current ? "link" : firstArrival(),
    });
    viewed.current = true;
  }, [tab]);

  const openTab = useCallback(
    (next: SuiteSettingsRouteTab) =>
      navigatePlaygroundEvalsRoute({
        type: "suite-settings",
        suiteId,
        tab: next,
      }),
    [suiteId],
  );

  const fix = useCallback(
    (key: EvalSuiteSettingKey, open: (key: EvalSuiteSettingKey) => void) => {
      // The name sits above the tabs, so every tab shows it.
      if (tab && key !== "name" && tab !== suiteSettingsTabFor(key))
        openTab(suiteSettingsTabFor(key));
      open(key);
    },
    [tab, openTab],
  );

  return {
    tab,
    pending: onPage && enabled === undefined,
    openTab,
    keepsDraft: tab ? staysInSuiteSettings : undefined,
    fix,
  };
}
