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
  const [status, setStatus] = useState<ConfidentialCimdCapabilityStatus>(
    HOSTED_MODE ? "idle" : "ready"
  );
  const [clientIdMetadataUrl, setClientIdMetadataUrl] = useState<
    string | undefined
  >(undefined);
  const [retryVersion, setRetryVersion] = useState(0);
  const retry = useCallback(
    () => setRetryVersion((version) => version + 1),
    []
  );

  useEffect(() => {
    if (!HOSTED_MODE) {
      setStatus("ready");
      setClientIdMetadataUrl(undefined);
      return;
    }
    if (!enabled) {
      setStatus("idle");
      setClientIdMetadataUrl(undefined);
      return;
    }
    if (!isSignedIn || !organizationId) {
      setStatus("unavailable");
      setClientIdMetadataUrl(undefined);
      return;
    }

    const controller = new AbortController();
    // Clear synchronously for each org/probe so the previous org's identity
    // can never be rendered as available while the new request is pending.
    setClientIdMetadataUrl(undefined);
    setStatus("loading");
    void fetchConfidentialCimdClientUrl({
      organizationId,
      signal: controller.signal,
    }).then((url) => {
      if (controller.signal.aborted) return;
      if (url) {
        setClientIdMetadataUrl(url);
        setStatus("ready");
      } else {
        setStatus("error");
      }
    });

    return () => controller.abort();
  }, [enabled, isSignedIn, organizationId, retryVersion]);

  return {
    status,
    clientIdMetadataUrl,
    retry,
    available: status === "ready",
  };
}
