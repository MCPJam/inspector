import { useAction, useQuery } from "convex/react";
import { useCallback, useState } from "react";

export type WorkspaceSlackTestStatus = "success" | "failure";

export interface WorkspaceSlackIntegrationStatus {
  workspaceId: string;
  connected: boolean;
  lastTestedAt: number | null;
  lastTestStatus: WorkspaceSlackTestStatus | null;
  lastTestError: string | null;
  updatedAt: number | null;
}

export function useWorkspaceSlackIntegration({
  isAuthenticated,
  workspaceId,
  canManageIntegration,
}: {
  isAuthenticated: boolean;
  workspaceId: string | null;
  canManageIntegration: boolean;
}) {
  const shouldQuery = isAuthenticated && !!workspaceId && canManageIntegration;

  const status = useQuery(
    "workspaceSlackIntegrations:getStatus" as any,
    shouldQuery ? ({ workspaceId } as any) : "skip",
  ) as WorkspaceSlackIntegrationStatus | undefined;

  const connectAction = useAction(
    "workspaceSlackIntegrations:connectIncomingWebhook" as any,
  );
  const sendTestAction = useAction(
    "workspaceSlackIntegrations:sendTestMessage" as any,
  );
  const disconnectAction = useAction(
    "workspaceSlackIntegrations:disconnect" as any,
  );

  const [isConnecting, setIsConnecting] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectWebhook = useCallback(
    async (webhookUrl: string) => {
      if (!workspaceId) {
        throw new Error("Workspace is required");
      }

      setIsConnecting(true);
      setError(null);
      try {
        return (await connectAction({
          workspaceId,
          webhookUrl,
        })) as WorkspaceSlackIntegrationStatus;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to connect Slack";
        setError(message);
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [connectAction, workspaceId],
  );

  const sendTestMessage = useCallback(async () => {
    if (!workspaceId) {
      throw new Error("Workspace is required");
    }

    setIsSendingTest(true);
    setError(null);
    try {
      return (await sendTestAction({
        workspaceId,
      })) as WorkspaceSlackIntegrationStatus;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send Slack test";
      setError(message);
      throw err;
    } finally {
      setIsSendingTest(false);
    }
  }, [sendTestAction, workspaceId]);

  const disconnect = useCallback(async () => {
    if (!workspaceId) {
      throw new Error("Workspace is required");
    }

    setIsDisconnecting(true);
    setError(null);
    try {
      return (await disconnectAction({
        workspaceId,
      })) as WorkspaceSlackIntegrationStatus;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to disconnect Slack";
      setError(message);
      throw err;
    } finally {
      setIsDisconnecting(false);
    }
  }, [disconnectAction, workspaceId]);

  return {
    status,
    error,
    isLoadingStatus: shouldQuery && status === undefined,
    isConnecting,
    isSendingTest,
    isDisconnecting,
    connectWebhook,
    sendTestMessage,
    disconnect,
  };
}
