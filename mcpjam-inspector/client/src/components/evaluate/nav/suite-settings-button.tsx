import { SlidersHorizontal } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { navigatePlaygroundEvalsRoute } from "../create-suite-navigation";

/** Opens Suite settings (D4) from a results page: the Suite and Suite run headers. */
export function SuiteSettingsButton({ suiteId }: { suiteId: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-8"
      data-testid="suite-settings-open"
      onClick={() =>
        navigatePlaygroundEvalsRoute({
          type: "suite-settings",
          suiteId,
          tab: "settings",
        })
      }
    >
      <SlidersHorizontal className="size-3.5" aria-hidden /> Suite settings
    </Button>
  );
}
