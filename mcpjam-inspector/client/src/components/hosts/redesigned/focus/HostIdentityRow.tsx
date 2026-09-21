import { Input } from "@mcpjam/design-system/input";
import type React from "react";
import { cn } from "@/lib/utils";

export interface HostIdentityRowProps {
  hostDisplayName: string;
  onHostDisplayNameChange: (next: string) => void;
  hasNameIssue: boolean;
  logoSrc?: string | null;
  action?: React.ReactNode;
  className?: string;
}

export function HostIdentityRow({
  hostDisplayName,
  onHostDisplayNameChange,
  hasNameIssue,
  logoSrc,
  action,
  className,
}: HostIdentityRowProps) {
  return (
    // Wrapping, not shrinking: the name field keeps a readable width and the
    // action group drops to its own line once the header gets narrow, rather
    // than squeezing the name down to a couple of letters.
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      {logoSrc ? (
        <img
          src={logoSrc}
          alt=""
          className="size-7 shrink-0 rounded-md object-contain"
        />
      ) : null}
      <Input
        value={hostDisplayName}
        onChange={(event) => onHostDisplayNameChange(event.target.value)}
        placeholder="Client name"
        aria-label="Client name"
        className={cn(
          "h-8 min-w-40 flex-1 basis-40 text-[13px]",
          hasNameIssue && "border-amber-500"
        )}
      />
      {action ? (
        // `ml-auto` keeps the group on the right edge of whichever line it
        // lands on, so a wrapped action still ends under the name field rather
        // than restarting at the left margin.
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
          {action}
        </div>
      ) : null}
    </div>
  );
}
