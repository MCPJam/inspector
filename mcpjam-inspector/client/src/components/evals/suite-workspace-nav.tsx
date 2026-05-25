import {
  SUITE_WORKSPACE_SECTIONS,
  type SuiteWorkspaceSection,
} from "@/lib/eval-suite-ia";
import { cn } from "@/lib/utils";

interface SuiteWorkspaceNavProps {
  activeSection: SuiteWorkspaceSection;
  onSectionChange: (section: SuiteWorkspaceSection) => void;
}

export function SuiteWorkspaceNav({
  activeSection,
  onSectionChange,
}: SuiteWorkspaceNavProps) {
  return (
    <div
      role="tablist"
      aria-label="Suite workspace sections"
      className="mb-4 flex shrink-0 items-center gap-1 border-b border-border/60"
    >
      {SUITE_WORKSPACE_SECTIONS.map((section) => {
        const active = section.id === activeSection;
        return (
          <button
            key={section.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSectionChange(section.id)}
            className={cn(
              "-mb-px border-b-2 border-transparent px-3 pb-2 pt-1 text-sm font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2",
              active
                ? "border-primary text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {section.label}
          </button>
        );
      })}
    </div>
  );
}
