import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { cn } from "@mcpjam/design-system/cn";
import type { EvalSuiteEnvironmentTarget } from "./types";
import {
  environmentTargetLabel,
  environmentTargetServersLabel,
} from "./helpers";

/**
 * Pick one of a mixed suite's environments to author cases against. Cases are
 * written for ONE environment's tools: the union of several describes a
 * server set no single run connects.
 */
export function EnvironmentTargetPicker({
  targets,
  value,
  onChange,
  idPrefix,
  legend = "Generate from",
  description = "This suite's environments connect different servers. Cases are written for the one you pick.",
  compact = false,
  disabled = false,
}: {
  targets: EvalSuiteEnvironmentTarget[];
  value: string | undefined;
  onChange: (environmentId: string) => void;
  /** Unique per surface: radio ids must not collide across open dialogs. */
  idPrefix: string;
  legend?: string;
  description?: string;
  /** The narrow popover layout. */
  compact?: boolean;
  disabled?: boolean;
}) {
  return (
    <fieldset
      className={cn(compact ? "space-y-1.5" : "space-y-3")}
      data-testid={`${idPrefix}-environment-picker`}
    >
      <legend className={cn("font-medium", compact ? "text-xs" : "text-sm")}>
        {legend}
      </legend>
      <p
        className={cn(
          "text-muted-foreground",
          compact ? "text-[11px]" : "text-xs",
        )}
      >
        {description}
      </p>
      <RadioGroup
        aria-label={legend}
        value={value ?? ""}
        onValueChange={onChange}
        disabled={disabled}
        className={cn("grid", compact ? "gap-1.5" : "gap-2")}
      >
        {targets.map((target) => {
          const id = `${idPrefix}-environment-${target.environmentId}`;
          return (
            <Label
              key={target.environmentId}
              htmlFor={id}
              className={cn(
                "flex cursor-pointer items-start gap-2 rounded-lg border border-border has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent",
                compact ? "p-2" : "p-3",
              )}
            >
              <RadioGroupItem id={id} value={target.environmentId} />
              <span className="min-w-0 space-y-1">
                <span className={cn("block", compact ? "text-xs" : "text-sm")}>
                  {environmentTargetLabel(target)}
                </span>
                <span
                  className={cn(
                    "block truncate font-normal text-muted-foreground",
                    compact ? "text-[11px]" : "text-xs",
                  )}
                >
                  {environmentTargetServersLabel(target)}
                </span>
              </span>
            </Label>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}
