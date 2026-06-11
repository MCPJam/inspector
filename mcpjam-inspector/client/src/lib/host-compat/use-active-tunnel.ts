import { useEffect, useState } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { getServerTunnel } from "@/lib/apis/mcp-tunnels-api";
import { HOSTED_MODE } from "@/lib/config";

/**
 * Read-only check for whether a server has a live ngrok tunnel — the same
 * signal `ServerConnectionCard` resolves for its tunnel controls, exposed
 * for compat surfaces (the detail-modal Compatibility tab) that don't hold
 * that state. Keeps the card strip and the modal tab in agreement on
 * transport reachability for a tunneled stdio server.
 *
 * Tunnels are a local-mode feature, so this is always `false` in hosted
 * mode and while disconnected.
 */
export function useActiveServerTunnel(
  serverName: string,
  enabled: boolean,
): boolean {
  const { getAccessToken } = useAuth();
  const [hasTunnel, setHasTunnel] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!enabled || HOSTED_MODE) {
      setHasTunnel(false);
      return;
    }
    (async () => {
      try {
        const token = await getAccessToken();
        const tunnel = await getServerTunnel(serverName, token);
        if (!cancelled) setHasTunnel(Boolean(tunnel?.url));
      } catch {
        if (!cancelled) setHasTunnel(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverName, enabled, getAccessToken]);

  return hasTunnel;
}
