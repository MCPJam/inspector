import { SlidersHorizontal } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@mcpjam/design-system/popover";
import type { EvalMatchOptions } from "@/shared/eval-matching";
import { MATCH_OPTIONS_DEFAULTS } from "@/shared/eval-matching";
import { ValidatorsSection } from "./validators-section";

interface RunValidatorsPopoverProps {
  /**
   * Fully-resolved options that already apply to this run (suite default
   * merged with case override). The popover layers `runOverride` on top.
   * Returned by `resolveMatchOptions`, which has dropped legacy
   * `allowExtraToolCalls` in favor of `maxExtraToolCalls`.
   */
  persistedEffective?: Required<Omit<EvalMatchOptions, "allowExtraToolCalls">>;
  runOverride: EvalMatchOptions | undefined;
  onChange: (next: EvalMatchOptions | undefined) => void;
  disabled?: boolean;
  /** Render variant: full button (default) or icon-only. */
  variant?: "button" | "icon";
}

export function RunValidatorsPopover({
  persistedEffective,
  runOverride,
  onChange,
  disabled,
  variant = "button",
}: RunValidatorsPopoverProps) {
  const persisted = persistedEffective ?? MATCH_OPTIONS_DEFAULTS;
  const hasOverride = !!runOverride && Object.keys(runOverride).length > 0;

  const trigger =
    variant === "icon" ? (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        title="Validator settings"
        aria-label="Validator settings"
        className="h-8 w-8 p-0"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </Button>
    ) : (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        className="h-8 gap-2"
      >
        <SlidersHorizontal className="h-4 w-4" />
        <span>Validators</span>
        {hasOverride ? (
          <Badge variant="secondary" className="ml-1 text-[10px] px-1.5 py-0">
            override
          </Badge>
        ) : null}
      </Button>
    );

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[20rem] p-3" align="end">
        <ValidatorsSection
          title="This run"
          density="compact"
          value={runOverride}
          inheritedFrom={persisted}
          onChange={onChange}
        />
      </PopoverContent>
    </Popover>
  );
}
