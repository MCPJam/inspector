import { cn } from "@/lib/utils";
import { SectionTab } from "@/components/settings/SectionTab";
import type {
  SUITE_SETTINGS_GROUPS,
  SuiteSettingsTabId,
} from "./suite-settings-groups";
import type { SuiteSettingsSubsection } from "./suite-settings-subsections";

type SettingsTab = (typeof SUITE_SETTINGS_GROUPS)[number];

/** Railway-style top tabs — one primary section at a time. */
export function SuiteSettingsGroupTabs({
  groups,
  activeId,
  onSelect,
}: {
  groups: readonly SettingsTab[];
  activeId: SuiteSettingsTabId;
  onSelect: (id: SuiteSettingsTabId) => void;
}) {
  return (
    <div className="overflow-x-auto scrollbar-hidden">
      <nav
        aria-label="Settings sections"
        className="flex w-max min-w-full items-end gap-1 border-b border-border/60"
      >
        {groups.map((group) => (
          <SectionTab
            key={group.id}
            label={group.label}
            isActive={activeId === group.id}
            onSelect={() => onSelect(group.id)}
          />
        ))}
      </nav>
    </div>
  );
}

/** Right rail — jump links only; no scroll-spy selection state. */
export function SuiteSettingsSubsectionNav({
  subsections,
  onSelect,
  className,
}: {
  subsections: readonly SuiteSettingsSubsection[];
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (subsections.length <= 1) return null;

  return (
    <nav
      aria-label="Settings subsections"
      className={cn("sticky top-6 self-start", className)}
    >
      <ul className="space-y-0.5">
        {subsections.map((subsection) => (
          <li key={subsection.id}>
            <button
              type="button"
              onClick={() => onSelect(subsection.id)}
              className="block w-full rounded-md px-2 py-1.5 text-left text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {subsection.label}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
