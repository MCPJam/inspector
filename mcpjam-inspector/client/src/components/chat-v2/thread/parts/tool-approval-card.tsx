import { useState } from "react";
import { Check, ChevronDown, X, ShieldCheck, ShieldX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/chat-utils";

type ApprovalState = "pending" | "approved" | "denied";

interface ToolApprovalCardProps {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown> | undefined;
  approvalId: string;
  onApprove: (id: string) => void;
  onDeny: (id: string) => void;
}

export function ToolApprovalCard({
  toolName,
  input,
  approvalId,
  onApprove,
  onDeny,
}: ToolApprovalCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<ApprovalState>("pending");

  const hasInput = input && Object.keys(input).length > 0;

  const handleApprove = () => {
    setState("approved");
    onApprove(approvalId);
  };

  const handleDeny = () => {
    setState("denied");
    onDeny(approvalId);
  };

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 space-y-3",
        state === "pending" && "border-amber-500/40 bg-amber-500/5",
        state === "approved" && "border-emerald-500/40 bg-emerald-500/5",
        state === "denied" && "border-destructive/40 bg-destructive/5",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          {state === "pending" && (
            <span className="text-amber-600 dark:text-amber-400">
              Approve tool call?
            </span>
          )}
          {state === "approved" && (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <ShieldCheck className="h-3.5 w-3.5" />
              Approved
            </span>
          )}
          {state === "denied" && (
            <span className="flex items-center gap-1 text-destructive">
              <ShieldX className="h-3.5 w-3.5" />
              Denied
            </span>
          )}
          <span className="text-muted-foreground font-mono text-xs">
            {toolName}
          </span>
        </div>
        {hasInput && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            {expanded ? "Hide" : "Show"} input
            <ChevronDown
              className={cn(
                "h-3 w-3 transition-transform",
                expanded && "rotate-180",
              )}
            />
          </button>
        )}
      </div>

      {expanded && hasInput && (
        <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-48 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}

      {state === "pending" && (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs border-emerald-500/40 text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-600 dark:text-emerald-400 dark:hover:text-emerald-400"
            onClick={handleApprove}
          >
            <Check className="h-3 w-3 mr-1" />
            Approve
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 px-3 text-xs border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={handleDeny}
          >
            <X className="h-3 w-3 mr-1" />
            Deny
          </Button>
        </div>
      )}
    </div>
  );
}
