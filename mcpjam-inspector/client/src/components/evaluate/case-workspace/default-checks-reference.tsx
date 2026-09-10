import { Button } from "@mcpjam/design-system/button";
import { ListChecks } from "lucide-react";

export function DefaultChecksReference({
  onOverride,
  onConfigureSuite,
}: {
  disabledChecks?: readonly string[];
  onConfigureSuite?: () => void;
  onOverride?: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="default-checks-reference"
      onClick={onOverride ?? onConfigureSuite}
    >
      <ListChecks className="size-3.5" />
      Show default assertions
    </Button>
  );
}
