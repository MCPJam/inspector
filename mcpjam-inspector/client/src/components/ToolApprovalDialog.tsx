import React, { useState } from "react";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Wrench, X, Check, RefreshCw, Server } from "lucide-react";
import type { PendingToolApproval } from "@/shared/tool-approval";

interface ToolApprovalDialogProps {
  pendingApproval: PendingToolApproval | null;
  onResponse: (
    action: "approve" | "deny",
    rememberForSession?: boolean,
  ) => Promise<void>;
  loading?: boolean;
}

export function ToolApprovalDialog({
  pendingApproval,
  onResponse,
  loading = false,
}: ToolApprovalDialogProps) {
  const [rememberForSession, setRememberForSession] = useState(false);

  // Reset remember checkbox when approval changes
  React.useEffect(() => {
    setRememberForSession(false);
  }, [pendingApproval?.approvalId]);

  const handleResponse = async (action: "approve" | "deny") => {
    await onResponse(action, rememberForSession);
  };

  // Format parameters for display
  const formatParameters = (params: Record<string, unknown>): string => {
    try {
      return JSON.stringify(params, null, 2);
    } catch {
      return String(params);
    }
  };

  return (
    <Dialog open={!!pendingApproval} onOpenChange={() => {}}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-medium">
            <Wrench className="h-4 w-4" />
            Tool Approval Required
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            The AI wants to execute a tool. Review the details and approve or
            deny.
          </DialogDescription>
        </DialogHeader>

        {pendingApproval && (
          <div className="space-y-4 py-4">
            {/* Tool Name */}
            <div>
              <Label className="text-sm font-medium">Tool Name</Label>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant="secondary" className="text-sm font-mono">
                  {pendingApproval.toolName}
                </Badge>
                {pendingApproval.serverName && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Server className="h-3 w-3" />
                    {pendingApproval.serverName}
                  </span>
                )}
              </div>
            </div>

            {/* Tool Description */}
            {pendingApproval.toolDescription && (
              <div>
                <Label className="text-sm font-medium">Description</Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  {pendingApproval.toolDescription}
                </p>
              </div>
            )}

            {/* Parameters */}
            <div>
              <Label className="text-sm font-medium">Parameters</Label>
              <pre className="mt-1 p-3 rounded-md bg-muted text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto">
                {formatParameters(pendingApproval.parameters)}
              </pre>
            </div>

            {/* Remember for session checkbox */}
            <div className="flex items-center space-x-2">
              <Checkbox
                id="remember-session"
                checked={rememberForSession}
                onCheckedChange={(checked) =>
                  setRememberForSession(checked === true)
                }
              />
              <label
                htmlFor="remember-session"
                className="text-sm text-muted-foreground cursor-pointer"
              >
                Don't ask again for this tool (this session only)
              </label>
            </div>
          </div>
        )}

        <DialogFooter className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => handleResponse("deny")}
            disabled={loading}
          >
            <X className="h-4 w-4 mr-2" />
            Deny
          </Button>
          <Button onClick={() => handleResponse("approve")} disabled={loading}>
            {loading ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Check className="h-4 w-4 mr-2" />
            )}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
