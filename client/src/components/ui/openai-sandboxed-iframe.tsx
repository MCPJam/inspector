import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
} from "react";

export interface OpenAISandboxedIframeHandle {
  postMessage: (data: unknown) => void;
}

export interface OpenAIWidgetCSP {
  connectDomains?: string[];
  resourceDomains?: string[];
}

interface OpenAISandboxedIframeProps {
  /** HTML content with window.openai bridge already injected */
  html: string | null;
  /** Sandbox attributes for inner iframe */
  sandbox?: string;
  /** CSP from openai/widgetCSP metadata */
  csp?: OpenAIWidgetCSP;
  /** Callback when sandbox proxy is ready */
  onReady?: () => void;
  /** Callback for messages from widget */
  onMessage: (event: MessageEvent) => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

export const OpenAISandboxedIframe = forwardRef<
  OpenAISandboxedIframeHandle,
  OpenAISandboxedIframeProps
>(function OpenAISandboxedIframe(
  {
    html,
    sandbox = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    csp,
    onReady,
    onMessage,
    className,
    style,
    title = "OpenAI App Widget",
  },
  ref
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [proxyReady, setProxyReady] = useState(false);
  const htmlSentRef = useRef(false);

  useImperativeHandle(
    ref,
    () => ({
      postMessage: (data: unknown) => {
        iframeRef.current?.contentWindow?.postMessage(data, "*");
      },
    }),
    []
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;

      // Handle sandbox ready
      if (event.data?.type === "openai:sandbox-ready") {
        setProxyReady(true);
        return;
      }

      // Forward all other messages to handler
      onMessage(event);
    },
    [onMessage]
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Send HTML to sandbox when ready
  useEffect(() => {
    if (!proxyReady || !html) return;

    // Only send HTML once per html content change
    if (htmlSentRef.current) return;
    htmlSentRef.current = true;

    iframeRef.current?.contentWindow?.postMessage(
      {
        type: "openai:load-widget",
        html,
        sandbox,
        csp,
      },
      "*"
    );

    // Notify parent that widget is ready after a small delay
    // to allow the inner iframe to initialize
    setTimeout(() => {
      onReady?.();
    }, 100);
  }, [proxyReady, html, sandbox, csp, onReady]);

  // Reset htmlSentRef when html changes
  useEffect(() => {
    htmlSentRef.current = false;
  }, [html]);

  // Cache-bust with timestamp in dev; use build hash in production
  const [sandboxUrl] = useState(() => {
    const version = import.meta.env.PROD
      ? import.meta.env.VITE_BUILD_HASH || "v1"
      : Date.now();
    return `/api/mcp/openai/sandbox-proxy?v=${version}`;
  });

  return (
    <iframe
      ref={iframeRef}
      src={sandboxUrl}
      sandbox="allow-scripts allow-same-origin"
      title={title}
      className={className}
      style={style}
    />
  );
});
