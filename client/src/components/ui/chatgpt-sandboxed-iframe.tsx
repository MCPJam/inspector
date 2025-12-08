import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from "react";

export interface ChatGPTSandboxedIframeHandle {
  postMessage: (data: unknown) => void;
  /**
   * Imperatively set the outer iframe height. Used for resize notifications to
   * avoid an extra React re-render when only the size changes.
   */
  setHeight: (height: number) => void;
}

interface ChatGPTSandboxedIframeProps {
  url: string | null;
  sandbox?: string;
  onReady?: () => void;
  onMessage: (event: MessageEvent) => void;
  /** When false, ignore openai:resize events and let parent size the iframe */
  allowAutoResize?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

/**
 * Triple-iframe architecture matching ChatGPT's actual implementation:
 *
 * Host (React component) - e.g., localhost:5173
 * └── Outer iframe (src="about:blank", sandbox with popups) - "jail" container
 *     ├── Middle iframe (sandbox-proxy on DIFFERENT origin, e.g., 127.0.0.1:5173)
 *     │   └── Inner iframe (srcdoc with widget) - actual widget content
 *     └── Measurement iframe (hidden, for layout calculations)
 *
 * Cross-origin isolation: Middle iframe uses localhost ↔ 127.0.0.1 swap
 * for true origin isolation, similar to ChatGPT's web-sandbox.oaiusercontent.com
 *
 * Message flow: Host <-> Outer <-> Middle <-> Inner
 */
export const ChatGPTSandboxedIframe = forwardRef<
  ChatGPTSandboxedIframeHandle,
  ChatGPTSandboxedIframeProps
>(function ChatGPTSandboxedIframe(
  {
    url,
    sandbox = "allow-scripts allow-same-origin allow-forms",
    onReady,
    onMessage,
    allowAutoResize = true,
    className,
    style,
    title = "ChatGPT App Widget",
  },
  ref,
) {
  const outerIframeRef = useRef<HTMLIFrameElement>(null);
  const middleIframeRef = useRef<HTMLIFrameElement | null>(null);
  const [outerReady, setOuterReady] = useState(false);
  const [proxyReady, setProxyReady] = useState(false);
  const urlSentRef = useRef(false);

  // Build cross-origin sandbox proxy URL (localhost ↔ 127.0.0.1 swap)
  const [sandboxProxyUrl, sandboxOrigin] = useMemo(() => {
    const currentHost = window.location.hostname;
    const currentPort = window.location.port;
    const protocol = window.location.protocol;

    // Swap localhost <-> 127.0.0.1 for cross-origin isolation
    let sandboxHost: string;
    if (currentHost === "localhost") {
      sandboxHost = "127.0.0.1";
    } else if (currentHost === "127.0.0.1") {
      sandboxHost = "localhost";
    } else {
      // In production or other environments, fall back to same-origin
      // Could be enhanced with a dedicated sandbox subdomain
      console.warn(
        "[ChatGPTSandboxedIframe] Cross-origin isolation not available, using same-origin",
      );
      sandboxHost = currentHost;
    }

    const portSuffix = currentPort ? `:${currentPort}` : "";
    const version = import.meta.env.PROD
      ? import.meta.env.VITE_BUILD_HASH || "v1"
      : Date.now();
    const url = `${protocol}//${sandboxHost}${portSuffix}/api/mcp/openai/sandbox-proxy?v=${version}`;
    const origin = `${protocol}//${sandboxHost}${portSuffix}`;

    return [url, origin];
  }, []);

  const setIframeHeight = useCallback((height: number) => {
    if (!Number.isFinite(height) || height <= 0) return;
    const rounded = Math.round(height);
    if (outerIframeRef.current) {
      outerIframeRef.current.style.height = `${rounded}px`;
    }
  }, []);

  // Expose postMessage to parent - routes through outer -> middle -> inner
  useImperativeHandle(
    ref,
    () => ({
      postMessage: (data: unknown) => {
        // Post to outer iframe, which forwards to middle
        outerIframeRef.current?.contentWindow?.postMessage(data, "*");
      },
      setHeight: setIframeHeight,
    }),
    [setIframeHeight],
  );

  // Handle messages from the iframe chain
  const handleMessage = useCallback(
    (event: MessageEvent) => {
      // Debug logging for openai messages
      if (event.data?.type?.startsWith?.("openai:")) {
        console.log(
          "[ChatGPTSandboxedIframe] Message received:",
          event.data?.type,
          "origin:",
          event.origin,
          "source:",
          event.source === outerIframeRef.current?.contentWindow
            ? "outer"
            : event.source === middleIframeRef.current?.contentWindow
              ? "middle"
              : "unknown",
        );
      }

      // Accept messages from outer iframe (which relays from middle)
      if (event.source !== outerIframeRef.current?.contentWindow) return;

      if (event.data?.type === "openai:resize" && allowAutoResize) {
        const nextHeight = Number(event.data.height);
        if (Number.isFinite(nextHeight) && nextHeight > 0)
          setIframeHeight(nextHeight);
      }

      // Handle proxy ready signal
      if (event.data?.type === "openai:sandbox-ready") {
        console.log("[ChatGPTSandboxedIframe] Proxy ready signal received");
        setProxyReady(true);
        return;
      }

      // Forward all other messages to the handler
      console.log(
        "[ChatGPTSandboxedIframe] Forwarding to onMessage:",
        event.data?.type,
      );
      onMessage(event);
    },
    [allowAutoResize, onMessage, setIframeHeight],
  );

  // Set up message listener
  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Initialize outer iframe with middle iframe when it loads
  useEffect(() => {
    const outerIframe = outerIframeRef.current;
    if (!outerIframe || outerReady) return;

    const handleOuterLoad = () => {
      const outerDoc = outerIframe.contentDocument;
      if (!outerDoc) {
        console.error(
          "[ChatGPTSandboxedIframe] Cannot access outer iframe contentDocument",
        );
        return;
      }

      // Guard against React StrictMode double-invoke - check actual DOM state
      if (outerDoc.getElementById("middle")) {
        console.log(
          "[ChatGPTSandboxedIframe] Middle iframe already exists, skipping",
        );
        middleIframeRef.current = outerDoc.getElementById(
          "middle",
        ) as HTMLIFrameElement;
        setOuterReady(true);
        return;
      }

      console.log(
        "[ChatGPTSandboxedIframe] Outer iframe loaded, injecting middle iframe",
      );
      console.log(
        "[ChatGPTSandboxedIframe] Cross-origin sandbox URL:",
        sandboxProxyUrl,
      );
      console.log("[ChatGPTSandboxedIframe] Sandbox origin:", sandboxOrigin);

      // Write the outer iframe's HTML content (contains middle iframe + relay script)
      outerDoc.open();
      outerDoc.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>ChatGPT Sandbox Container</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; overflow: hidden; }
    iframe { border: none; width: 100%; height: 100%; }
    .measurement { z-index: -1; position: absolute; width: 100%; height: 100%; top: 0; left: 0; opacity: 0; }
  </style>
</head>
<body>
  <iframe
    id="middle"
    src="${sandboxProxyUrl}"
    sandbox="allow-scripts allow-same-origin allow-forms"
    allow="local-network-access *; microphone *; midi *"
  ></iframe>
  <iframe
    id="measurement"
    aria-hidden="true"
    tabindex="-1"
    class="measurement"
  ></iframe>
  <script>
    // Message relay: Host <-> Middle iframe (cross-origin)
    const middle = document.getElementById("middle");
    const SANDBOX_ORIGIN = "${sandboxOrigin}";

    window.addEventListener("message", (event) => {
      if (event.source === window.parent) {
        // Forward from host to middle (use specific origin for security)
        if (middle.contentWindow) {
          middle.contentWindow.postMessage(event.data, SANDBOX_ORIGIN);
        }
      } else if (event.source === middle.contentWindow) {
        // Validate origin from middle iframe
        if (event.origin !== SANDBOX_ORIGIN) {
          console.warn("[Outer] Ignoring message from unexpected origin:", event.origin);
          return;
        }
        // Forward from middle to host
        window.parent.postMessage(event.data, "*");
      }
    });
  </script>
</body>
</html>`);
      outerDoc.close();

      // Store reference to middle iframe for debugging
      middleIframeRef.current = outerDoc.getElementById(
        "middle",
      ) as HTMLIFrameElement;
      setOuterReady(true);
    };

    // For about:blank, it loads immediately
    if (outerIframe.contentDocument?.readyState === "complete") {
      handleOuterLoad();
    } else {
      outerIframe.addEventListener("load", handleOuterLoad);
      return () => outerIframe.removeEventListener("load", handleOuterLoad);
    }
  }, [sandboxProxyUrl, sandboxOrigin, outerReady]);

  // Send widget URL when proxy is ready
  useEffect(() => {
    if (!proxyReady || !url || urlSentRef.current) return;

    urlSentRef.current = true;
    console.log("[ChatGPTSandboxedIframe] Sending widget URL to proxy:", url);

    // Post to outer iframe, which relays to middle (proxy)
    outerIframeRef.current?.contentWindow?.postMessage(
      { type: "openai:load-widget", url, sandbox },
      "*",
    );

    setTimeout(() => onReady?.(), 100);
  }, [proxyReady, url, sandbox, onReady]);

  // Reset all state when url changes
  useEffect(() => {
    urlSentRef.current = false;
    setProxyReady(false);
    setOuterReady(false);
  }, [url]);

  return (
    <iframe
      ref={outerIframeRef}
      src="about:blank"
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-forms"
      // Permissions Policy matching ChatGPT's actual implementation
      allow="local-network-access *; microphone *; midi *"
      title={title}
      className={className}
      style={style}
    />
  );
});
