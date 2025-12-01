/**
 * SandboxedIframe - DRY Double-Iframe Sandbox Component
 *
 * Provides a secure double-iframe architecture for rendering untrusted HTML:
 * Host Page → Sandbox Proxy (different origin) → Guest UI
 *
 * The sandbox proxy:
 * 1. Runs in a different origin for security isolation
 * 2. Loads guest HTML via srcdoc when ready
 * 3. Forwards messages between host and guest (except sandbox-internal)
 *
 * Per SEP-1865, this component is designed to be reusable for MCP Apps
 * and potentially future OpenAI SDK consolidation.
 */

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";

export interface SandboxedIframeHandle {
  postMessage: (data: unknown) => void;
}

/** CSP metadata per SEP-1865 */
interface UIResourceCSP {
  connectDomains?: string[];
  resourceDomains?: string[];
}

interface SandboxedIframeProps {
  /** HTML content to render in the sandbox */
  html: string | null;
  /** Sandbox attribute for the inner iframe */
  sandbox?: string;
  /** CSP metadata from resource _meta.ui.csp (SEP-1865) */
  csp?: UIResourceCSP;
  /** Callback when sandbox proxy is ready */
  onProxyReady?: () => void;
  /** Callback for messages from guest UI (excluding sandbox-internal messages) */
  onMessage: (event: MessageEvent) => void;
  /** CSS class for the outer iframe */
  className?: string;
  /** Inline styles for the outer iframe */
  style?: React.CSSProperties;
  /** Title for accessibility */
  title?: string;
}

/**
 * SandboxedIframe provides a secure double-iframe architecture per SEP-1865.
 *
 * Message flow:
 * 1. Proxy sends ui/notifications/sandbox-ready when loaded
 * 2. Host sends ui/notifications/sandbox-resource-ready with HTML
 * 3. Guest UI initializes and communicates via JSON-RPC 2.0
 */
export const SandboxedIframe = forwardRef<
  SandboxedIframeHandle,
  SandboxedIframeProps
>(function SandboxedIframe(
  {
    html,
    sandbox = "allow-scripts allow-same-origin allow-forms allow-popups",
    csp,
    onProxyReady,
    onMessage,
    className,
    style,
    title = "Sandboxed Content",
  },
  ref,
) {
  const outerRef = useRef<HTMLIFrameElement>(null);
  const [proxyReady, setProxyReady] = useState(false);

  // Expose postMessage to parent
  useImperativeHandle(
    ref,
    () => ({
      postMessage: (data: unknown) => {
        outerRef.current?.contentWindow?.postMessage(data, "*");
      },
    }),
    [],
  );

  // Handle messages from sandbox proxy
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.source !== outerRef.current?.contentWindow) return;

      const { jsonrpc, method } =
        (event.data as { jsonrpc?: string; method?: string }) || {};
      if (jsonrpc !== "2.0") return;

      // Sandbox ready notification (per SEP-1865)
      if (method === "ui/notifications/sandbox-ready") {
        setProxyReady(true);
        onProxyReady?.();
        return;
      }

      // Ignore other sandbox-internal messages
      if (method?.startsWith("ui/notifications/sandbox-")) {
        return;
      }

      // Forward all other messages to parent handler
      onMessage(event);
    },
    [onMessage, onProxyReady],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Send HTML and CSP to sandbox when ready (SEP-1865)
  useEffect(() => {
    if (!proxyReady || !html) return;

    outerRef.current?.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html, sandbox, csp },
      },
      "*",
    );
  }, [proxyReady, html, sandbox, csp]);

  // Stable cache-bust URL (only changes on page refresh, not on re-renders)
  const [sandboxProxyUrl] = useState(
    () => `/api/mcp/sandbox-proxy?v=${Date.now()}`,
  );

  return (
    <iframe
      ref={outerRef}
      src={sandboxProxyUrl}
      sandbox="allow-scripts allow-same-origin"
      title={title}
      className={className}
      style={style}
    />
  );
});
