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

import { HOSTED_MODE } from "@/lib/config";
import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from "react";
import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import { SEP_1865_PERMISSION_FEATURES } from "@/lib/client-config-v2";

export interface SandboxedIframeHandle {
  postMessage: (data: unknown) => void;
  getIframeElement: () => HTMLIFrameElement | null;
}

interface SandboxedIframeProps {
  /** HTML content to render in the sandbox */
  html: string | null;
  /** Sandbox attribute for the inner iframe */
  sandbox?: string;
  /** CSP metadata from resource _meta.ui.csp (SEP-1865) */
  csp?: McpUiResourceCsp;
  /** Permissions metadata from resource _meta.ui.permissions (SEP-1865) */
  permissions?: McpUiResourcePermissions;
  /**
   * Inspector-only: extra `sandbox=` tokens unioned with the spec-mandated
   * `allow-scripts allow-same-origin` on both outer and inner iframes.
   * Models tokens real hosts emit (e.g. `allow-forms`) that aren't part of
   * SEP-1865 metadata.
   */
  sandboxAttrs?: string[];
  /**
   * Inspector-only: extra Permissions Policy entries appended to outer/inner
   * iframe `allow=`. Keys are kebab Permissions Policy tokens
   * (`fullscreen`, `web-share`); the 4 spec features
   * (camera/microphone/geolocation/clipboard-write) live in `permissions`
   * and are NOT permitted here.
   */
  allowFeatures?: Record<string, string>;
  /**
   * Inspector-only: per-directive CSP source-expression overrides merged
   * into the inner doc's `<meta http-equiv="Content-Security-Policy">`.
   * Keys are CSP directive names (`script-src`, …); values are token arrays
   * (`["'unsafe-eval'", "'wasm-unsafe-eval'"]`).
   */
  cspDirectives?: Record<string, string[]>;
  /** Skip CSP injection entirely (for permissive/testing mode) */
  permissive?: boolean;
  /** Callback when sandbox proxy is ready */
  onProxyReady?: () => void;
  /** Callback for messages from guest UI (excluding sandbox-internal messages) */
  onMessage: (event: MessageEvent) => void;
  /** CSS class for the outer iframe */
  className?: string;
  /** Inline styles for the outer iframe */
  style?: React.CSSProperties;
  /** Host color scheme used to keep transparent iframe canvas rendering aligned */
  colorScheme?: "light" | "dark";
  /** Title for accessibility */
  title?: string;
}

/**
 * SandboxedIframe provides a secure double-iframe architecture per SEP-1865.
 *
 * Message flow:
 * 1. Proxy sends ui/notifications/sandbox-proxy-ready when loaded
 * 2. Host sends ui/notifications/sandbox-resource-ready with HTML
 * 3. Guest UI initializes and communicates via JSON-RPC 2.0
 */
export const SandboxedIframe = forwardRef<
  SandboxedIframeHandle,
  SandboxedIframeProps
>(function SandboxedIframe(
  {
    html,
    sandbox = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    csp,
    permissions,
    sandboxAttrs,
    allowFeatures,
    cspDirectives,
    permissive,
    onProxyReady,
    onMessage,
    className,
    style,
    colorScheme,
    title = "Sandboxed Content",
  },
  ref,
) {
  const outerRef = useRef<HTMLIFrameElement>(null);
  const [proxyReady, setProxyReady] = useState(false);

  // SEP-1865: Host and Sandbox MUST have different origins
  const [sandboxProxyUrl] = useState(() => {
    const currentHost = window.location.hostname;
    const currentPort = window.location.port;
    const protocol = window.location.protocol;

    let sandboxHost: string;
    if (currentHost === "localhost") {
      sandboxHost = "127.0.0.1";
    } else if (currentHost === "127.0.0.1") {
      sandboxHost = "localhost";
    } else {
      // In production/hosted environments, fall back to same-origin
      // Note: SEP-1865 recommends different origins, but same-origin works with sandbox attribute
      console.warn(
        "[SandboxedIframe] Cross-origin isolation not available for hostname:",
        currentHost,
        "- falling back to same-origin sandbox",
      );
      sandboxHost = currentHost;
    }

    const portSuffix = currentPort ? `:${currentPort}` : "";
    const proxyPath = HOSTED_MODE
      ? "/api/web/apps/mcp-apps/sandbox-proxy"
      : "/api/apps/mcp-apps/sandbox-proxy";
    return `${protocol}//${sandboxHost}${portSuffix}${proxyPath}?v=${Date.now()}`;
  });

  const sandboxProxyOrigin = useMemo(() => {
    try {
      return new URL(sandboxProxyUrl).origin;
    } catch {
      return "*";
    }
  }, [sandboxProxyUrl]);

  useImperativeHandle(
    ref,
    () => ({
      postMessage: (data: unknown) => {
        outerRef.current?.contentWindow?.postMessage(data, sandboxProxyOrigin);
      },
      getIframeElement: () => outerRef.current,
    }),
    [sandboxProxyOrigin],
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.origin !== sandboxProxyOrigin && sandboxProxyOrigin !== "*") {
        return;
      }
      if (event.source !== outerRef.current?.contentWindow) return;

      // CSP violation messages (not JSON-RPC) - forward directly
      if (event.data?.type === "mcp-apps:csp-violation") {
        onMessage(event);
        return;
      }

      // File upload/download messages (not JSON-RPC) - forward directly
      if (
        event.data?.type === "openai:uploadFile" ||
        event.data?.type === "openai:getFileDownloadUrl"
      ) {
        onMessage(event);
        return;
      }

      const { jsonrpc, method } =
        (event.data as { jsonrpc?: string; method?: string }) || {};
      if (jsonrpc !== "2.0") return;

      if (method === "ui/notifications/sandbox-proxy-ready") {
        setProxyReady(true);
        onProxyReady?.();
        return;
      }

      if (method?.startsWith("ui/notifications/sandbox-")) {
        return;
      }

      onMessage(event);
    },
    [onMessage, onProxyReady, sandboxProxyOrigin],
  );

  useEffect(() => {
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleMessage]);

  // Build allow attribute for outer iframe based on requested permissions.
  //
  // Same authoritative-profile semantic as `sandboxAttrs` above: when
  // `allowFeatures` is provided (even as `{}`), the profile is the
  // source of truth for non-spec Permissions Policy features, and the
  // renderer's legacy defaults (`local-network-access *`, `midi *`) are
  // dropped. A profile that doesn't list those features models a real
  // host that doesn't emit them — and the iframe must match, or
  // experiments using Web MIDI / Local Network Access would pass in
  // MCPJam while the real host blocks them.
  //
  // The 4 SEP-1865 spec permissions (camera/microphone/geolocation/
  // clipboard-write) ALWAYS flow through from `permissions` regardless
  // of `allowFeatures` — they're orthogonal user-facing knobs. Only the
  // inspector-only legacy defaults are conditional.
  //
  // Per Permissions Policy spec, `;` separates features.
  const outerAllowAttribute = useMemo(() => {
    const allowFeaturesIsAuthoritative = allowFeatures !== undefined;
    const allowList = allowFeaturesIsAuthoritative
      ? []
      : ["local-network-access *", "midi *"];
    if (permissions?.camera) allowList.push("camera *");
    if (permissions?.microphone) allowList.push("microphone *");
    if (permissions?.geolocation) allowList.push("geolocation *");
    if (permissions?.clipboardWrite) allowList.push("clipboard-write *");
    if (allowFeatures) {
      // Defense-in-depth: skip spec features in case the canonicalizer
      // was bypassed. `permissions.allow.{camera,...}` is the single
      // source of truth — see SEP_1865_PERMISSION_FEATURES.
      const specFeatures = new Set<string>(SEP_1865_PERMISSION_FEATURES);
      for (const k of Object.keys(allowFeatures).sort()) {
        if (specFeatures.has(k)) continue;
        const allowlist = allowFeatures[k];
        if (typeof allowlist !== "string" || allowlist.length === 0) continue;
        // Reject `;` and `,` in keys and values. The Permissions Policy
        // iframe `allow=` attribute uses `;` to separate features; allowing
        // either character through here turns the per-feature filter into
        // a directive-injection bypass (e.g. `fullscreen: "*; camera *"`
        // would smuggle a `camera *` grant past the spec-feature check
        // above). `,` is the corresponding separator in HTTP-header
        // Permissions-Policy syntax and is rejected for symmetry.
        if (/[;,]/.test(k) || /[;,]/.test(allowlist)) continue;
        allowList.push(`${k} ${allowlist}`);
      }
    }
    return allowList.join("; ");
  }, [permissions, allowFeatures]);

  // Outer iframe `sandbox=` value.
  //
  // When `sandboxAttrs` is provided (even as `[]`), the profile is the
  // authoritative source: the iframe gets `allow-scripts allow-same-origin`
  // plus exactly what the profile lists. This is what makes "model the
  // real host's emitted tokens" actually work — e.g. a Claude-modeled
  // profile with `sandboxAttrs: ["allow-forms"]` gets exactly those three
  // tokens, not those PLUS the renderer's legacy permissive default.
  //
  // When `sandboxAttrs` is undefined (no profile opinion), fall back to
  // the caller's `sandbox` prop so existing call sites — which pass a
  // wider permissive baseline — behave unchanged.
  //
  // `undefined` vs `[]` matters here: `[]` is the explicit "spec-minimum
  // only" intent, mirroring the canonicalizer's preservation contract.
  const outerSandboxAttribute = useMemo(() => {
    const tokens = new Set<string>();
    if (sandboxAttrs !== undefined) {
      tokens.add("allow-scripts");
      tokens.add("allow-same-origin");
      for (const t of sandboxAttrs) {
        const trimmed = t.trim();
        if (trimmed.length === 0) continue;
        // Reject tokens with internal whitespace. A profile (or custom-
        // token input) that smuggles `"allow-forms allow-popups-to-
        // escape-sandbox"` would otherwise land in the Set as one entry
        // but the join(" ") below would emit it as two real sandbox
        // flags — silently widening the iframe grant beyond what the
        // editor/matrix display. Reject is safer than split: the entry
        // visibly does nothing (user notices) instead of taking effect
        // invisibly.
        if (/\s/.test(trimmed)) continue;
        tokens.add(trimmed);
      }
    } else {
      for (const t of sandbox.split(/\s+/)) {
        if (t.length > 0) tokens.add(t);
      }
      // Defense in depth: spec-mandated tokens are always present even
      // if a caller passes a malformed `sandbox` prop.
      tokens.add("allow-scripts");
      tokens.add("allow-same-origin");
    }
    return Array.from(tokens).sort().join(" ");
  }, [sandbox, sandboxAttrs]);

  // Send HTML, CSP, and permissions to sandbox when ready (SEP-1865)
  useEffect(() => {
    if (!proxyReady || !html) return;

    outerRef.current?.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: {
          html,
          sandbox,
          csp,
          permissions,
          sandboxAttrs,
          // `allowFeatures` is intentionally NOT forwarded to the proxy:
          // it applies to the OUTER iframe only. The inner iframe gets the
          // 4 spec permissions (via `permissions`) and nothing else, matching
          // real claude.ai's outer-grants-fullscreen / inner-trims-to-spec
          // pattern. Centralizing the outer/inner split here means the proxy
          // can't accidentally widen the inner grant by reading a stale
          // field.
          cspDirectives,
          permissive,
          colorScheme,
        },
      },
      sandboxProxyOrigin,
    );
    // `colorScheme` and `allowFeatures` are intentionally OMITTED from
    // this dep list. The proxy handles `sandbox-resource-ready` by
    // rebuilding the CSP and assigning `inner.srcdoc`, which reloads the
    // widget and drops any in-iframe state — so we MUST NOT re-fire this
    // effect for props that don't actually affect the inner iframe.
    //
    //   - `colorScheme`: flows through the dedicated
    //     `sandbox-color-scheme-changed` effect below, which updates the
    //     inner document's color-scheme without a reload.
    //   - `allowFeatures`: applies only to the OUTER iframe's `allow=`
    //     attribute (computed in `outerAllowAttribute` above and applied
    //     declaratively via JSX, so React reconciliation handles the
    //     update without a reload). It's not forwarded in the params
    //     payload at all (see the comment above the field). Re-including
    //     it here would silently full-reload the widget every time a
    //     user toggles an entry in the AppExtensionTab editor.
  }, [
    proxyReady,
    html,
    sandbox,
    csp,
    permissions,
    sandboxAttrs,
    cspDirectives,
    permissive,
    sandboxProxyOrigin,
  ]);

  // Keep iframe color-scheme in sync without reloading the widget document.
  useEffect(() => {
    if (!proxyReady || !colorScheme) return;

    outerRef.current?.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-color-scheme-changed",
        params: { colorScheme },
      },
      sandboxProxyOrigin,
    );
  }, [proxyReady, colorScheme, sandboxProxyOrigin]);

  const iframeStyle = colorScheme ? { ...style, colorScheme } : style;

  return (
    <iframe
      ref={outerRef}
      src={sandboxProxyUrl}
      sandbox={outerSandboxAttribute}
      allow={outerAllowAttribute}
      title={title}
      className={className}
      style={iframeStyle}
    />
  );
});
