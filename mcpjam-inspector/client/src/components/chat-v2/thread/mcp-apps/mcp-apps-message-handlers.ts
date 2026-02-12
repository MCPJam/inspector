import type { CspViolation } from "@/stores/widget-debug-store";

interface CspViolationPayload {
  directive?: string;
  blockedUri?: string;
  sourceFile?: string;
  lineNumber?: number;
  columnNumber?: number;
  effectiveDirective?: string;
  timestamp?: number;
}

interface HandleCompatMessageArgs {
  data: unknown;
  onOpenModal: (title: string, params: Record<string, unknown>, template: string | null) => void;
  onCloseModal: () => void;
}

export function handleOpenAiCompatMessage({
  data,
  onOpenModal,
  onCloseModal,
}: HandleCompatMessageArgs): boolean {
  const payload = data as
    | {
        jsonrpc?: string;
        method?: string;
        params?: {
          title?: string;
          params?: Record<string, unknown>;
          template?: string;
        };
      }
    | undefined;

  if (
    payload?.jsonrpc !== "2.0" ||
    typeof payload.method !== "string" ||
    !payload.method.startsWith("openai/")
  ) {
    return false;
  }

  if (payload.method === "openai/requestModal") {
    const params = payload.params ?? {};
    onOpenModal(params.title || "Modal", params.params || {}, params.template || null);
    return true;
  } else if (payload.method === "openai/requestClose") {
    onCloseModal();
    return true;
  }

  return false;
}

interface BuildCspViolationHandlerArgs {
  toolCallId: string;
  serverId: string;
  addUiLog: (entry: {
    widgetId: string;
    serverId: string;
    direction: "host-to-ui" | "ui-to-host";
    protocol: "mcp-apps";
    method: string;
    message: unknown;
  }) => void;
  addCspViolation: (
    toolCallId: string,
    violation: CspViolation,
  ) => void;
}

export function buildCspViolationHandler({
  toolCallId,
  serverId,
  addUiLog,
  addCspViolation,
}: BuildCspViolationHandlerArgs) {
  return (event: MessageEvent) => {
    const data = event.data as CspViolationPayload | undefined;
    if (!data) return;

    addUiLog({
      widgetId: toolCallId,
      serverId,
      direction: "ui-to-host",
      protocol: "mcp-apps",
      method: "csp-violation",
      message: data,
    });

    addCspViolation(toolCallId, {
      directive: data.directive || "unknown",
      effectiveDirective: data.effectiveDirective,
      blockedUri: data.blockedUri || "unknown",
      sourceFile: data.sourceFile,
      lineNumber: data.lineNumber,
      columnNumber: data.columnNumber,
      timestamp: data.timestamp || Date.now(),
    });

    console.warn(
      `[MCP Apps CSP Violation] ${data.directive}: Blocked ${data.blockedUri}`,
      data.sourceFile
        ? `at ${data.sourceFile}:${data.lineNumber}:${data.columnNumber}`
        : "",
    );
  };
}
