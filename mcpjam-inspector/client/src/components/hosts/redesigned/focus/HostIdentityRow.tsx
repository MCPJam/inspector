import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";

export interface HostIdentityRowProps {
  hostDisplayName: string;
  onHostDisplayNameChange: (next: string) => void;
  hasNameIssue: boolean;
  logoSrc?: string | null;
  className?: string;
}

export function HostIdentityRow({
  hostDisplayName,
  onHostDisplayNameChange,
  hasNameIssue,
  logoSrc,
  className,
}: HostIdentityRowProps) {
  return (
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
        placeholder="Host name"
        aria-label="Host name"
        className={cn(
          "h-8 min-w-0 flex-1 text-[13px]",
          hasNameIssue && "border-amber-500"
        )}
      />
    </div>
  );
}
