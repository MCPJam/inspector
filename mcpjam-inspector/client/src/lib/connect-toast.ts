/**
 * A server connect as one toast that settles: "Connecting…" while the
 * handshake runs, then connected or why not, in the same toast. Picking a
 * server connects it on its own, so without this nothing says it is happening.
 */
import type { ExternalToast } from "sonner";
import { toast } from "@/lib/toast";

export function startConnectToast(serverName: string) {
  const id = toast.loading(`Connecting ${serverName}...`);
  return {
    connected: () => toast.success(`${serverName} connected`, { id }),
    failed: (message: string, options?: ExternalToast) =>
      toast.error(message, { ...options, id }),
    dismiss: () => toast.dismiss(id),
  };
}
