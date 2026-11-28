import type { ReactNode } from "react";
import { cn } from "@mcpjam/design-system/cn";

/**
 * One Set up run message in its own box, with the action that fixes it. A
 * sheet with several messages stacks several notices, never one shared box.
 */
export function PreflightNotice({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-testid="preflight-notice"
      className={cn(
        "flex items-center gap-3 rounded-lg border border-warning/45 bg-warning/10 p-3 text-xs",
        className,
      )}
    >
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
