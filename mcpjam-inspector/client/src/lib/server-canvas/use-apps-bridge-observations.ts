/**
 * Feeds the widget host's traffic log into the Apps bridge observer while the
 * `server-canvas` rollout is on. One observer serves every widget surface, so
 * its tallies and its flush timer are shared.
 */
import { useCallback } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { HOSTED_MODE } from "@/lib/config";
import { authFetch } from "@/lib/session-token";
import { tryResolveProjectServer } from "@/lib/apis/web/context";
import {
  createAppsBridgeObserver,
  flushWhenPageHides,
  ObservationWriteRefused,
  type BridgeDelivery,
  type BridgeLogEvent,
  type BridgeObservationBatch,
} from "./apps-bridge-observer";

export const BRIDGE_OBSERVATIONS_PATH = HOSTED_MODE
  ? "/api/web/server-features/observations"
  : "/api/mcp/server-features/observations";

async function postBridgeObservations(
  batch: BridgeObservationBatch,
  { keepalive }: BridgeDelivery,
) {
  const response = await authFetch(BRIDGE_OBSERVATIONS_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(batch),
    keepalive,
  });
  if (!response.ok) throw new ObservationWriteRefused(response.status);
}

let sharedObserver: ReturnType<typeof createAppsBridgeObserver> | undefined;

function bridgeObserver() {
  if (!sharedObserver) {
    const observer = createAppsBridgeObserver({
      resolveServer: tryResolveProjectServer,
      send: postBridgeObservations,
    });
    // Registered once, for the one observer, for the page's lifetime.
    flushWhenPageHides(() => void observer.flush({ keepalive: true }));
    sharedObserver = observer;
  }
  return sharedObserver;
}

/** Wraps the traffic log sink so the bridge is observed when the canvas is on. */
export function useAppsBridgeObservations<Event extends BridgeLogEvent>(
  addLog: (event: Event) => void,
): (event: Event) => void {
  const canvasOn = useFeatureFlagEnabled("server-canvas") === true;
  return useCallback(
    (event: Event) => {
      addLog(event);
      if (!canvasOn) return;
      try {
        bridgeObserver().observe(event);
      } catch (error) {
        // Observation must never break the bridge it watches.
        console.debug("[server-canvas] bridge observation skipped", error);
      }
    },
    [addLog, canvasOn],
  );
}
