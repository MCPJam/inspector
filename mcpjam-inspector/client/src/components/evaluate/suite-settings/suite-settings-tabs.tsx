import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SuiteSettingsRouteTab } from "@/lib/eval-route-types";
import { EvalHeaderActions, EvalHeaderBack } from "../nav/eval-header-actions";
import type { SuiteSettingsNav } from "./use-suite-settings-nav";

const SUITE_SETTINGS_TABS: readonly {
  tab: SuiteSettingsRouteTab;
  label: string;
}[] = [
  { tab: "settings", label: "Settings" },
  { tab: "cases", label: "Test cases" },
  { tab: "evaluators", label: "Default evaluators" },
];

/**
 * Settings and Default evaluators are two views of one sheet and one draft:
 * each tab hides the other's rows rather than unmounting them, so an edit on
 * one tab survives a visit to the other. Every row's root carries
 * `data-setting-key`; Default evaluators is the `passOrFail` row.
 */
export function suiteSettingsTabRowsClass(
  tab: SuiteSettingsRouteTab | null,
): string {
  if (tab === "settings") return "[&>[data-setting-key=passOrFail]]:hidden";
  if (tab === "evaluators")
    return "[&>:not([data-setting-key=passOrFail])]:hidden";
  return "";
}

/**
 * Sits above the suite name, which `SuiteHeader` renders and edits. The
 * negative margin takes up the top padding `SuiteHeader` keeps for itself.
 */
export function SuiteSettingsEyebrow() {
  return (
    <p className="mx-auto -mb-7 w-full max-w-5xl px-6 pt-8 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      Suite settings
    </p>
  );
}

/** Below the suite name: what the page is for, then one link per tab. */
export function SuiteSettingsTabBar({
  tab,
  caseCount,
  onSelect,
}: {
  tab: SuiteSettingsRouteTab;
  caseCount: number;
  onSelect: (tab: SuiteSettingsRouteTab) => void;
}) {
  return (
    <div className="mx-auto w-full max-w-5xl px-6">
      <p className="text-sm text-muted-foreground">
        What this suite tests and how it grades. Changes apply to the next run.
      </p>
      <nav
        aria-label="Suite settings"
        className="mt-4 flex gap-1 overflow-x-auto border-b border-border"
      >
        {SUITE_SETTINGS_TABS.map((item) => {
          const active = item.tab === tab;
          return (
            <button
              key={item.tab}
              type="button"
              aria-current={active ? "page" : undefined}
              data-testid={`suite-settings-tab-${item.tab}`}
              onClick={() => onSelect(item.tab)}
              className={cn(
                "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                active
                  ? "border-primary font-medium text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
              {item.tab === "cases" ? (
                <span className="ml-1.5 tabular-nums text-muted-foreground">
                  {caseCount}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Save settings and Back to suite, in the breadcrumb bar. `save` is absent on
 * the Test cases tab: each case saves on its own page.
 */
export function SuiteSettingsHeaderActions({
  save,
  onBack,
}: {
  save?: ReactNode;
  onBack: () => void;
}) {
  return (
    <EvalHeaderActions>
      {save}
      <EvalHeaderBack label="Back to suite" onClick={onBack} />
    </EvalHeaderActions>
  );
}

/**
 * Everything below the suite name on the tabbed page: the tab bar, and Save
 * settings with Back to suite in the breadcrumb bar. Nothing without a tab.
 */
export function SuiteSettingsChrome({
  nav,
  caseCount,
  save,
  onBack,
}: {
  nav: SuiteSettingsNav;
  caseCount: number;
  save: ReactNode;
  onBack: () => void;
}) {
  if (!nav.tab) return null;
  return (
    <>
      <SuiteSettingsTabBar
        tab={nav.tab}
        caseCount={caseCount}
        onSelect={nav.openTab}
      />
      <SuiteSettingsHeaderActions
        save={nav.tab === "cases" ? undefined : save}
        onBack={onBack}
      />
    </>
  );
}
