import { toast } from "@/lib/toast";
import { presentConnectionError } from "@/lib/connection-error-presentation";

type ToastAction = { label: string; onClick: () => void };

/** Connection toasts reuse reviewed copy; server rows own recovery and diagnostics. */
export function toastServerConnectionFailure(
  serverName: string,
  error: unknown,
  options?: { action?: ToastAction },
): void {
  const { title, explanation } = presentConnectionError(error, { serverName });
  toast.error(title, { description: explanation, action: options?.action });
}
