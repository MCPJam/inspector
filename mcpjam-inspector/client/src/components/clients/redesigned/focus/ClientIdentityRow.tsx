import { Input } from "@mcpjam/design-system/input";
import { cn } from "@/lib/utils";

export interface HostIdentityRowProps {
  hostDisplayName: string;
  onHostDisplayNameChange: (next: string) => void;
  hasNameIssue: boolean;
  className?: string;
}

export function ClientIdentityRow({
  hostDisplayName,
  onHostDisplayNameChange,
  hasNameIssue,
  className,
}: HostIdentityRowProps) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-3",
        className,
      )}
    >
      <Input
        value={hostDisplayName}
        onChange={(event) => onHostDisplayNameChange(event.target.value)}
        placeholder="Client name"
        aria-label="Client name"
        className={cn(
          "h-8 min-w-0 flex-1 text-[13px]",
          hasNameIssue && "border-amber-500",
        )}
      />
    </div>
  );
}
