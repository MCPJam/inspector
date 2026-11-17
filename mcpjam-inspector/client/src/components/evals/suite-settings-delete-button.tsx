import { Trash2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@/lib/utils";
import { EVAL_DESTRUCTIVE_BUTTON_CLASS } from "./constants";

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
      size="icon"
      className={cn("size-8", EVAL_DESTRUCTIVE_BUTTON_CLASS)}
      aria-label="Delete suite"
      title="Delete suite"
      disabled={disabled}
      onClick={onDelete}
    >
      <Trash2 />
    </Button>
  );
}
