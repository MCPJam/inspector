import { toast } from "sonner";
import { copyToClipboard } from "@/lib/clipboard";
import {
  attributeToServer,
  splitServerAttribution,
} from "@/lib/server-error-copy";

type ToastAction = { label: string; onClick: () => void };

/**
 * Raise a connect/reconnect failure as a toast the developer can act on.
 *
 * Defaults to a Copy action because the toast is the only place the failure
 * appears for servers that never reached a card, and it is gone in seconds —
 * long before anyone retypes it into an agent. A caller with an action that
 * FIXES the failure passes its own: sonner renders one, and fixing beats
 * copying.
 */
export function toastServerConnectionFailure(
  serverName: string,
  message: string,
  options?: { action?: ToastAction },
): void {
  const { title, description } = splitServerAttribution(serverName, message);
  toast.error(title, {
    description,
    action: options?.action ?? {
      label: "Copy",
      onClick: () => {
        void copyToClipboard(attributeToServer(serverName, message)).then(
          (copied) => {
            if (copied) toast.success("Error copied");
            else toast.error("Could not copy the error");
          },
        );
      },
    },
  });
}
