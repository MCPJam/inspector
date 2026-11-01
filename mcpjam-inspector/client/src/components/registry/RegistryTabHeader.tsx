import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { LandingPageHeader } from "@/components/shared/landing-page-header";

export type RegistryView = "directories" | "organization";

/**
 * Registry landing header. Same chrome as Swarm and Evaluate: the title, an
 * underline switch when both sources exist, and the view's action on the right.
 * One source fills the page. The two are different jobs (a curated shelf, a
 * searchable catalog) and do not stack.
 */
export function RegistryTabHeader({
  view,
  showViewSwitch,
  onViewChange,
  onAddServer,
}: {
  view: RegistryView;
  /** Both sources have something to show, so the underline switch is warranted. */
  showViewSwitch: boolean;
  onViewChange: (view: RegistryView) => void;
  /** Present on the organization view when this member can add an entry. */
  onAddServer?: () => void;
}) {
  return (
    <LandingPageHeader
      testId="registry-tab-header"
      title="Registry"
      tabs={
        showViewSwitch
          ? {
              value: view,
              options: [
                { value: "organization", label: "Organization" },
                { value: "directories", label: "Directories" },
              ],
              onChange: onViewChange,
              ariaLabel: "Registry source",
              indicatorId: "registry-source",
            }
          : undefined
      }
      actions={
        onAddServer ? (
          <Button
            type="button"
            size="sm"
            className="shrink-0 rounded-lg px-4 font-medium"
            onClick={onAddServer}
          >
            <Plus className="mr-1.5 size-4" />
            Add a server
          </Button>
        ) : undefined
      }
    />
  );
}
