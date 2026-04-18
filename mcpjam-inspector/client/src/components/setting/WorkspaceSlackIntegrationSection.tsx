import { useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { useWorkspaceSlackIntegration } from "@/hooks/useWorkspaceSlackIntegration";

interface WorkspaceSlackIntegrationSectionProps {
  workspaceId: string | null;
  workspaceName: string | null;
  organizationId?: string;
  canManageIntegration: boolean;
}

function formatTimestamp(timestamp: number | null): string | null {
  if (!timestamp) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function WorkspaceSlackIntegrationSection({
  workspaceId,
  workspaceName,
  organizationId,
  canManageIntegration,
}: WorkspaceSlackIntegrationSectionProps) {
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const { signIn } = useAuth();
  const [webhookInput, setWebhookInput] = useState("");
  const [isReplaceMode, setIsReplaceMode] = useState(false);
  const [disconnectConfirmOpen, setDisconnectConfirmOpen] = useState(false);

  const isSyncedWorkspace = Boolean(workspaceId && organizationId);
  const {
    status,
    error,
    isLoadingStatus,
    isConnecting,
    isSendingTest,
    isDisconnecting,
    connectWebhook,
    sendTestMessage,
    disconnect,
  } = useWorkspaceSlackIntegration({
    isAuthenticated,
    workspaceId: isSyncedWorkspace ? workspaceId : null,
    canManageIntegration: isSyncedWorkspace && canManageIntegration,
  });

  const isBusy = isConnecting || isSendingTest || isDisconnecting;
  const lastTestedLabel = formatTimestamp(status?.lastTestedAt ?? null);
  const lastUpdatedLabel = formatTimestamp(status?.updatedAt ?? null);

  const handleSaveWebhook = async () => {
    const trimmedWebhook = webhookInput.trim();
    if (!trimmedWebhook) {
      toast.error("Slack webhook URL is required");
      return;
    }

    try {
      await connectWebhook(trimmedWebhook);
      setWebhookInput("");
      setIsReplaceMode(false);
      toast.success(
        status?.connected ? "Slack webhook updated" : "Slack connected",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to connect Slack",
      );
    }
  };

  const handleSendTestMessage = async () => {
    try {
      await sendTestMessage();
      toast.success("Slack test message sent");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to send Slack test message",
      );
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
      setDisconnectConfirmOpen(false);
      setWebhookInput("");
      setIsReplaceMode(false);
      toast.success("Slack disconnected");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to disconnect Slack",
      );
    }
  };

  if (isAuthLoading) {
    return (
      <div className="rounded-md border border-border/40 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Checking Slack integration access…
        </p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-between gap-4 rounded-md border border-border/40 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Slack</span>
            <Badge variant="outline">Sign in required</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Sign in to connect this workspace to a Slack incoming webhook.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => signIn()}>
          Sign in
        </Button>
      </div>
    );
  }

  if (!isSyncedWorkspace) {
    return (
      <div className="rounded-md border border-border/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Slack</span>
          <Badge variant="outline">Synced workspaces only</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Slack integrations are available after this workspace is synced to
          MCPJam.
        </p>
      </div>
    );
  }

  if (!canManageIntegration) {
    return (
      <div className="rounded-md border border-border/40 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Slack</span>
          <Badge variant="outline">Read only</Badge>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Only workspace admins can manage Slack integrations.
        </p>
      </div>
    );
  }

  const isConnected = status?.connected ?? false;

  return (
    <>
      <div className="rounded-md border border-border/40 px-4 py-4 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Slack</span>
              <Badge variant={isConnected ? "secondary" : "outline"}>
                {isConnected ? "Connected" : "Not connected"}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Send workspace notifications to a Slack channel with an incoming
              webhook.
            </p>
          </div>
          {lastUpdatedLabel ? (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdatedLabel}
            </span>
          ) : null}
        </div>

        {isLoadingStatus ? (
          <p className="text-sm text-muted-foreground">
            Loading Slack integration…
          </p>
        ) : null}

        {!isLoadingStatus && isConnected ? (
          <div className="rounded-md border border-border/40 bg-muted/20 px-3 py-3 space-y-1">
            <p className="text-sm font-medium">
              {workspaceName || "This workspace"} is connected to Slack.
            </p>
            <p className="text-xs text-muted-foreground">
              {lastTestedLabel
                ? `Last tested ${lastTestedLabel}.`
                : "No test message has been sent yet."}
            </p>
            {status?.lastTestError ? (
              <p className="text-xs text-destructive">{status.lastTestError}</p>
            ) : null}
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : null}

        {!isLoadingStatus && (!isConnected || isReplaceMode) ? (
          <div className="space-y-2">
            <Input
              type="url"
              value={webhookInput}
              onChange={(event) => setWebhookInput(event.target.value)}
              placeholder="https://hooks.slack.com/services/..."
              disabled={isBusy}
            />
            <p className="text-xs text-muted-foreground">
              Saved webhook URLs are never shown again after they are stored.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  void handleSaveWebhook();
                }}
                disabled={isBusy || webhookInput.trim().length === 0}
              >
                {isConnecting
                  ? isConnected
                    ? "Saving…"
                    : "Connecting…"
                  : isConnected
                    ? "Save webhook"
                    : "Connect Slack"}
              </Button>
              {isConnected ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => {
                    setIsReplaceMode(false);
                    setWebhookInput("");
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {!isLoadingStatus && isConnected && !isReplaceMode ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                void handleSendTestMessage();
              }}
              disabled={isBusy}
            >
              {isSendingTest ? "Sending…" : "Send test message"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setIsReplaceMode(true)}
              disabled={isBusy}
            >
              Replace webhook
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => setDisconnectConfirmOpen(true)}
              disabled={isBusy}
            >
              Disconnect
            </Button>
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={disconnectConfirmOpen}
        onOpenChange={setDisconnectConfirmOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Slack?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the stored Slack webhook for{" "}
              {workspaceName || "this workspace"}. You can reconnect it at any
              time with a new webhook URL.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDisconnecting}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void handleDisconnect();
              }}
              disabled={isDisconnecting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDisconnecting ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
