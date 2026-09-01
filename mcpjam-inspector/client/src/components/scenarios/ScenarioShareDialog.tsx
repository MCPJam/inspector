/**
 * The single share affordance for a User Testing scenario.
 *
 * One primary `Share` button in the detail header opens this; the landing page
 * carries no tester-link strip of its own. Link, invite, and access only —
 * the roster and link rotation stay on the Edit route's Sharing permissions
 * section ({@link ScenarioShareSection}), which renders the same controls in
 * full.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { ScenarioShareSection } from "@/components/scenarios/ScenarioShareSection";
import type { ScenarioSettings } from "@/hooks/useScenarios";

export function ScenarioShareDialog({
  scenario,
  open,
  onOpenChange,
}: {
  scenario: ScenarioSettings;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[85vh] flex-col sm:max-w-lg"
        aria-describedby={undefined}
        data-testid="user-testing-share-dialog"
      >
        <DialogHeader>
          <DialogTitle>Share this study with your users</DialogTitle>
        </DialogHeader>
        {/* Only the body scrolls. The dialog's close button is absolutely
            positioned inside DialogContent, so scrolling that carries the X
            off screen and leaves Esc as the only way out. */}
        <div className="flex-1 overflow-y-auto">
          <ScenarioShareSection
            scenario={scenario}
            showMembers={false}
            allowRotate={false}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
