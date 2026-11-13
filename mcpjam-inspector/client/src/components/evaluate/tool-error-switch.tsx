import { useId } from "react";
import { Label } from "@mcpjam/design-system/label";
import { Switch } from "@mcpjam/design-system/switch";

const LABEL = "Fail this case when a tool call returns an error";

/**
 * Whether a tool error fails this case. It sits with the expected outcome
 * because turning it off is how a case is graded on that outcome when the
 * model can recover from a tool that answered with an error.
 */
export function ToolErrorSwitch({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="space-y-0.5 pt-1" data-testid="case-tool-error-switch">
      <div className="flex items-center gap-2">
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onCheckedChange}
          aria-label={LABEL}
          aria-describedby={helpId}
        />
        <Label htmlFor={id} className="text-xs font-normal text-foreground">
          {LABEL}
        </Label>
      </div>
      <p id={helpId} className="pl-10 text-xs text-muted-foreground">
        {checked
          ? "Any tool error fails this case, even if the model recovers."
          : "Tool errors alone don't fail this case. They still show in the trace."}
      </p>
    </div>
  );
}
