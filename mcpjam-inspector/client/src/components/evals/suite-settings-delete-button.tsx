import { Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";

/**
 * Icon-only delete in the Suite settings header. It only asks: the caller's
 * `onDelete` arms the shared "Delete Test Suite" dialog, which does the
 * deleting. Disabled while a delete or a settings save is in flight, because
 * a delete landing mid-commit fails the commit against a missing suite.
 */
export function SuiteSettingsDeleteButton({
  disabled,
  onDelete,
}: {
  disabled: boolean;
  onDelete: () => void;
}) {
  return (
    <Button
      type="button"
      variant="destructive"
      size="icon"
      className="size-8"
      aria-label="Delete suite"
      title="Delete suite"
      disabled={disabled}
      onClick={onDelete}
    >
      <Trash2 />
    </Button>
  );
}
