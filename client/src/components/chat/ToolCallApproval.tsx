import React from "react";
import { cn } from "@/lib/utils/request/utils";
import { Check, X } from "lucide-react";

export interface PendingToolCall {
  id: string;
  name: string;
  input: unknown;
  timestamp: Date;
}

interface ToolCallApprovalProps {
  toolCall: PendingToolCall;
  onApprove: (toolCall: PendingToolCall) => void;
  onReject: (toolCall: PendingToolCall) => void;
}

export const ToolCallApproval: React.FC<ToolCallApprovalProps> = ({
  toolCall,
  onApprove,
  onReject,
}) => {
  return (
    <div className="flex gap-4 p-4 border border-slate-200 dark:border-slate-700 rounded-xl bg-slate-50 dark:bg-slate-800 mb-2">
      <div className="flex-1">
        <div className="text-sm font-medium text-slate-800 dark:text-slate-200 mb-1">
          Approve tool call: {toolCall.name}
        </div>
        <div className="text-xs text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 p-2 rounded font-mono overflow-auto max-h-28">
          {JSON.stringify(toolCall.input, null, 2)}
        </div>
      </div>
      <div className="flex flex-col justify-center gap-2">
        <button
          onClick={() => onApprove(toolCall)}
          className={cn(
            "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
            "bg-green-600 hover:bg-green-700 text-white transition-colors",
          )}
          title="Approve tool call"
        >
          <Check className="w-4 h-4" />
        </button>
        <button
          onClick={() => onReject(toolCall)}
          className={cn(
            "flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center",
            "bg-red-600 hover:bg-red-700 text-white transition-colors",
          )}
          title="Reject tool call"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
