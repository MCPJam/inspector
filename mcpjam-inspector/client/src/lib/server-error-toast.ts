import { toast } from "@/lib/toast";
import { splitServerAttribution } from "@/lib/server-error-copy";

type ToastAction = { label: string; onClick: () => void };

/**
 * The one way a connect/reconnect failure reaches the user.
 *
 * Three call sites used to build their own sentence around the same failure
 * ("Failed to connect to X: …"), which is why one server refusing produced two
 * differently-worded toasts. Copying is not handled here: `@/lib/toast` puts a
 * copy button on every error toast and it reads the description too.
 */
export function toastServerConnectionFailure(
  serverName: string,
  message: string,
  options?: { action?: ToastAction },
): void {
  const { title, description } = splitServerAttribution(serverName, message);
  toast.error(title, { description, action: options?.action });
}
