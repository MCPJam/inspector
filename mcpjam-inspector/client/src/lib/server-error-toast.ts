import { createElement } from "react";
import {
  toast,
  CopyableErrorMessage,
  protocolPinFallbackAction,
} from "@/lib/toast";
import { presentConnectionError } from "@/lib/connection-error-presentation";
import { formatErrorDetailsForCopy } from "@/lib/error-technical-details";

type ToastAction = { label: string; onClick: () => void };

export function toastServerConnectionFailure(
  serverName: string,
  error: unknown,
  options?: { action?: ToastAction },
): void {
  const { title, explanation, diagnostics } = presentConnectionError(error, {
    serverName,
  });
  const copyText = formatErrorDetailsForCopy(
    { ...diagnostics, title, oneLine: explanation },
    true,
  );
  toast.error(createElement(CopyableErrorMessage, { text: title, copyText }), {
    description: explanation,
    action:
      options?.action ??
      protocolPinFallbackAction(diagnostics.rawMessage, undefined)?.action,
  });
}
