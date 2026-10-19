import { useCallback, useRef, useState } from "react";

/**
 * Counts every `sandbox-proxy-ready`, not just the first. The proxy announces
 * itself once per document load, so a second one means the outer iframe
 * reloaded under us — e.g. a persistent surface re-parented when its anchor
 * remounted. That new document has no view and the bridge still points at the
 * old window, so the renderer keys its bridge on this count: each one rebuilds
 * the bridge, which re-sends the resource. 0 = the proxy has not loaded yet.
 *
 * `onReady` keeps a stable identity (SandboxedIframe calls it per proxy load,
 * and every call rebuilds the bridge) and logs the current values via refs.
 */
export function useSandboxProxyGeneration({
  bridgeTransportReady,
  hasWidgetHtml,
  logReady,
}: {
  bridgeTransportReady: boolean;
  hasWidgetHtml: boolean;
  logReady: (details: Record<string, unknown>) => void;
}): { generation: number; onReady: () => void } {
  const [generation, setGeneration] = useState(0);
  const bridgeTransportReadyRef = useRef(bridgeTransportReady);
  bridgeTransportReadyRef.current = bridgeTransportReady;
  const hasWidgetHtmlRef = useRef(hasWidgetHtml);
  hasWidgetHtmlRef.current = hasWidgetHtml;
  const logReadyRef = useRef(logReady);
  logReadyRef.current = logReady;

  const onReady = useCallback(() => {
    setGeneration((current) => current + 1);
    logReadyRef.current({
      bridgeTransportReady: bridgeTransportReadyRef.current,
      hasWidgetHtml: hasWidgetHtmlRef.current,
    });
  }, []);

  return { generation, onReady };
}
