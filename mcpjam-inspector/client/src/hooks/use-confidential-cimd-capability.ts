import { useCallback, useEffect, useState } from "react";
import { HOSTED_MODE } from "@/lib/config";
import { fetchConfidentialCimdClientUrl } from "@/lib/xaa/idp-endpoints";

export type ConfidentialCimdCapabilityStatus =
  | "idle"
  | "loading"
  | "ready"
  | "error"
  | "unavailable";

export function useConfidentialCimdCapability({
  enabled,
  organizationId,
  isSignedIn,
}: {
  enabled: boolean;
  organizationId?: string | null;
  isSignedIn?: boolean;
}) {
  const [retryVersion, setRetryVersion] = useState(0);
  const probeKey = JSON.stringify([
    enabled,
    Boolean(isSignedIn),
    organizationId ?? null,
    retryVersion,
  ]);
  const statusForCurrentInputs = (): ConfidentialCimdCapabilityStatus => {
    if (!HOSTED_MODE) return "ready";
    if (!enabled) return "idle";
    if (!isSignedIn || !organizationId) return "unavailable";
    return "loading";
  };
  const [probe, setProbe] = useState<{
    key: string;
    status: ConfidentialCimdCapabilityStatus;
    clientIdMetadataUrl?: string;
  }>(() => ({ key: probeKey, status: statusForCurrentInputs() }));
  const retry = useCallback(
    () => setRetryVersion((version) => version + 1),
    []
  );

  useEffect(() => {
    if (!HOSTED_MODE) {
      setProbe({ key: probeKey, status: "ready" });
      return;
    }
    if (!enabled) {
      setProbe({ key: probeKey, status: "idle" });
      return;
    }
    if (!isSignedIn || !organizationId) {
      setProbe({ key: probeKey, status: "unavailable" });
      return;
    }

    const controller = new AbortController();
    setProbe({ key: probeKey, status: "loading" });
    void fetchConfidentialCimdClientUrl({
      organizationId,
      signal: controller.signal,
    }).then((url) => {
      if (controller.signal.aborted) return;
      if (url) {
        setProbe({
          key: probeKey,
          status: "ready",
          clientIdMetadataUrl: url,
        });
      } else {
        setProbe({ key: probeKey, status: "error" });
      }
    });

    return () => controller.abort();
  }, [enabled, isSignedIn, organizationId, probeKey]);

  // Effects run after render. Never expose a previous context's ready state
  // during that render: a key mismatch derives a fail-closed status directly
  // from the current inputs and withholds the old metadata URL.
  const currentProbe =
    probe.key === probeKey
      ? probe
      : {
          key: probeKey,
          status: statusForCurrentInputs(),
          clientIdMetadataUrl: undefined,
        };

  return {
    status: currentProbe.status,
    clientIdMetadataUrl: currentProbe.clientIdMetadataUrl,
    retry,
    available: currentProbe.status === "ready",
  };
}
