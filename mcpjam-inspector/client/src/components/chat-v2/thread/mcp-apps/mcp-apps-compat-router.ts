import type { CheckoutSession } from "@/shared/acp-types";
import { handleGetFileDownloadUrlMessage, handleUploadFileMessage } from "./widget-file-messages";

interface CompatRouterOptions {
  widgetId: string;
  serverId: string;
  addUiLog: (log: {
    widgetId: string;
    serverId: string;
    direction: "host-to-ui" | "ui-to-host";
    protocol: "mcp-apps";
    method: string;
    message: unknown;
  }) => void;
  postMessageToSandbox: (message: unknown) => void;
  onOpenModal: (payload: {
    title: string;
    params: Record<string, unknown>;
    template: string | null;
  }) => void;
  onCloseModal: () => void;
  onRequestCheckout: (payload: {
    callId: number;
    session: CheckoutSession;
  }) => void;
}

export function createMcpAppsCompatRouter(options: CompatRouterOptions) {
  return (data: unknown): boolean => {
    const message = data as Record<string, unknown> | null;
    if (!message) return false;

    if (message.type === "openai:uploadFile") {
      void handleUploadFileMessage(
        message as Parameters<typeof handleUploadFileMessage>[0],
        options.postMessageToSandbox,
      );
      return true;
    }

    if (message.type === "openai:getFileDownloadUrl") {
      handleGetFileDownloadUrlMessage(
        message as Parameters<typeof handleGetFileDownloadUrlMessage>[0],
        options.postMessageToSandbox,
      );
      return true;
    }

    if (
      message.jsonrpc === "2.0" &&
      typeof message.method === "string" &&
      message.method.startsWith("openai/")
    ) {
      options.addUiLog({
        widgetId: options.widgetId,
        serverId: options.serverId,
        direction: "ui-to-host",
        protocol: "mcp-apps",
        method: message.method,
        message,
      });

      if (message.method === "openai/requestModal") {
        const params = (message.params as Record<string, unknown>) ?? {};
        options.onOpenModal({
          title: (params.title as string) || "Modal",
          params: (params.params as Record<string, unknown>) || {},
          template: (params.template as string) || null,
        });
        return true;
      }

      if (message.method === "openai/requestClose") {
        options.onCloseModal();
        return true;
      }

      if (message.method === "openai/requestCheckout") {
        const params = (message.params as Record<string, unknown>) ?? {};
        const { callId, ...sessionData } = params;
        options.onRequestCheckout({
          callId: callId as number,
          session: sessionData as CheckoutSession,
        });
        return true;
      }

      return true;
    }

    return false;
  };
}
