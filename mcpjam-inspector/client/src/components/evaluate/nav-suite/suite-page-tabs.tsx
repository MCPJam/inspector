/**
 * Runs | Test cases under the Suite page's header. Test cases has its own
 * address (`?view=test-cases`), the one a test case's Back already opens.
 */
import { PAGE_HEADER_TAB_CLASSNAME } from "@/components/shared/landing-page-header";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";

export type SuitePageTab = "runs" | "test-cases";

const TABS = [
  { value: "runs", label: "Runs" },
  { value: "test-cases", label: "Test cases" },
] as const;

export function SuitePageTabs({
  value,
  onChange,
}: {
  value: SuitePageTab;
  onChange: (tab: SuitePageTab) => void;
}) {
  return (
    <div className="border-b border-border" data-testid="suite-page-tabs">
      <ViewModeSelector<SuitePageTab>
        className={PAGE_HEADER_TAB_CLASSNAME}
        ariaLabel="Suite view"
        indicatorId="suite-page-tabs"
        value={value}
        onChange={onChange}
        options={TABS}
      />
    </div>
  );
}
