import { createContext, type ReactNode } from "react";
import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

/**
 * The Suite settings page's compact layout: label beside the control, the
 * hint behind an info pill. False (the default) keeps the settings sheet's
 * stacked layout unchanged.
 */
export const SuiteSettingsCompactContext = createContext(false);

/** A focusable info pill that shows a row's hint on hover and on focus. */
export function SettingInfoPill({
  label,
  hint,
}: {
  label: string;
  hint: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="button"
          tabIndex={0}
          aria-label={`About ${label}`}
          className="inline-flex cursor-help items-center rounded-full border border-border bg-muted/50 p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="size-3" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent variant="muted" className="max-w-72 text-xs leading-snug">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
