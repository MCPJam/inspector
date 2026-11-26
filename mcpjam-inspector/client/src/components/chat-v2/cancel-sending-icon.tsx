import { Loader2 } from "lucide-react";

/**
 * The send spinner with a stop square inside: a send is being prepared, and a
 * click cancels it. The square is a span because `Button` sizes every SVG.
 */
export function CancelSendingIcon() {
  return (
    <span className="relative flex size-4 items-center justify-center">
      <Loader2 className="absolute size-4 animate-spin" />
      <span className="size-1.5 rounded-[1px] bg-current" />
    </span>
  );
}
