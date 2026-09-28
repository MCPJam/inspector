import {
  useSessionHistoricalHostConfig,
  type SessionHistoricalHostConfig,
} from "./useSharedChatThreads";
import { shouldQueryHostId, useHost } from "./useClients";
import {
  hostSnapshotFromStyle,
  snapshotFromHostConfig,
  type HostSnapshot,
} from "@/lib/host-snapshot";

export type HostSnapshotResolution =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; snapshot: HostSnapshot }
  | { status: "unavailable" };

export function hostSnapshotFromHistoricalConfig(
  config: SessionHistoricalHostConfig,
): HostSnapshot | null {
  const snapshot = hostSnapshotFromStyle(config.hostStyle);
  if (!snapshot) return null;
  return {
    ...snapshot,
    hostCapabilitiesOverride: config.hostCapabilitiesOverride,
    chatUiOverride: config.chatUiOverride,
    mcpProfile: config.mcpProfile,
  };
}

/** sessionId is chatSessions._id, not the runtime chatSessionId. */
export function useHostSnapshotForSession(
  sessionId: string | null,
): HostSnapshotResolution {
  const { config } = useSessionHistoricalHostConfig({ sessionId });
  if (!sessionId) return { status: "idle" };
  if (config === undefined) return { status: "loading" };
  const snapshot = config && hostSnapshotFromHistoricalConfig(config);
  return snapshot ? { status: "ready", snapshot } : { status: "unavailable" };
}

/** Used for a selected live target before its persisted session is available. */
export function useHostSnapshotForHost(
  hostId: string | null,
  isAuthenticated: boolean,
): HostSnapshotResolution {
  const { host, isLoading } = useHost({ hostId, isAuthenticated });
  if (!hostId) return { status: "idle" };
  if (!shouldQueryHostId(hostId)) {
    const snapshot = hostSnapshotFromStyle(hostId);
    return snapshot ? { status: "ready", snapshot } : { status: "unavailable" };
  }
  if (isLoading) return { status: "loading" };
  return host
    ? { status: "ready", snapshot: snapshotFromHostConfig(host.config) }
    : { status: "unavailable" };
}
