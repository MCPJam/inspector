import { useAction, useQuery } from "convex/react";
import { useCallback, useState } from "react";

export type ProjectSlackTestStatus = "success" | "failure";

export interface ProjectSlackIntegrationStatus {
  projectId: string;
  connected: boolean;
  lastTestedAt: number | null;
  lastTestStatus: ProjectSlackTestStatus | null;
  lastTestError: string | null;
  updatedAt: number | null;
}

export function useProjectSlackIntegration({
  isAuthenticated,
  projectId,
  canManageIntegration,
}: {
  isAuthenticated: boolean;
  projectId: string | null;
  canManageIntegration: boolean;
}) {
  const shouldQuery = isAuthenticated && !!projectId && canManageIntegration;

  const status = useQuery(
    "projectSlackIntegrations:getStatus" as any,
    shouldQuery ? ({ projectId } as any) : "skip",
  ) as ProjectSlackIntegrationStatus | undefined;

  const connectAction = useAction(
    "projectSlackIntegrations:connectIncomingWebhook" as any,
  );
  const sendTestAction = useAction(
    "projectSlackIntegrations:sendTestMessage" as any,
  );
  const disconnectAction = useAction(
    "projectSlackIntegrations:disconnect" as any,
  );

  const [isConnecting, setIsConnecting] = useState(false);
  const [isSendingTest, setIsSendingTest] = useState(false);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connectWebhook = useCallback(
    async (webhookUrl: string) => {
      if (!projectId) {
        throw new Error("Project is required");
      }

      setIsConnecting(true);
      setError(null);
      try {
        return (await connectAction({
          projectId,
          webhookUrl,
        })) as ProjectSlackIntegrationStatus;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to connect Slack";
        setError(message);
        throw err;
      } finally {
        setIsConnecting(false);
      }
    },
    [connectAction, projectId],
  );

  const sendTestMessage = useCallback(async () => {
    if (!projectId) {
      throw new Error("Project is required");
    }

    setIsSendingTest(true);
    setError(null);
    try {
      return (await sendTestAction({
        projectId,
      })) as ProjectSlackIntegrationStatus;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to send Slack test";
      setError(message);
      throw err;
    } finally {
      setIsSendingTest(false);
    }
  }, [sendTestAction, projectId]);

  const disconnect = useCallback(async () => {
    if (!projectId) {
      throw new Error("Project is required");
    }

    setIsDisconnecting(true);
    setError(null);
    try {
      return (await disconnectAction({
        projectId,
      })) as ProjectSlackIntegrationStatus;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to disconnect Slack";
      setError(message);
      throw err;
    } finally {
      setIsDisconnecting(false);
    }
  }, [disconnectAction, projectId]);

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
