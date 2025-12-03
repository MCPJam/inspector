import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from "react";

export interface ChatGPTSandboxedIframeHandle {
  postMessage: (data: unknown) => void;
}

export interface ChatGPTWidgetCSP {
  connectDomains?: string[];
  resourceDomains?: string[];
}

interface ChatGPTSandboxedIframeProps {
  html: string | null;
  sandbox?: string;
  csp?: ChatGPTWidgetCSP;
  onReady?: () => void;
  onMessage: (event: MessageEvent) => void;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
}

export const ChatGPTSandboxedIframe = forwardRef<ChatGPTSandboxedIframeHandle, ChatGPTSandboxedIframeProps>(
  function ChatGPTSandboxedIframe({ html, sandbox = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox", csp, onReady, onMessage, className, style, title = "ChatGPT App Widget" }, ref) {
    const iframeRef = useRef<HTMLIFrameElement>(null);
    const [proxyReady, setProxyReady] = useState(false);
    const htmlSentRef = useRef(false);

    useImperativeHandle(ref, () => ({
      postMessage: (data: unknown) => iframeRef.current?.contentWindow?.postMessage(data, "*"),
    }), []);

    const handleMessage = useCallback((event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === "openai:sandbox-ready") { setProxyReady(true); return; }
      onMessage(event);
    }, [onMessage]);

    useEffect(() => {
      window.addEventListener("message", handleMessage);
      return () => window.removeEventListener("message", handleMessage);
    }, [handleMessage]);

    useEffect(() => {
      if (!proxyReady || !html || htmlSentRef.current) return;
      htmlSentRef.current = true;
      iframeRef.current?.contentWindow?.postMessage({ type: "openai:load-widget", html, sandbox, csp }, "*");
      setTimeout(() => onReady?.(), 100);
    }, [proxyReady, html, sandbox, csp, onReady]);

    useEffect(() => { htmlSentRef.current = false; }, [html]);

    const [sandboxUrl] = useState(() => {
      const version = import.meta.env.PROD ? import.meta.env.VITE_BUILD_HASH || "v1" : Date.now();
      return `/api/mcp/openai/sandbox-proxy?v=${version}`;
    });

    return <iframe ref={iframeRef} src={sandboxUrl} sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" title={title} className={className} style={style} />;
  }
);
