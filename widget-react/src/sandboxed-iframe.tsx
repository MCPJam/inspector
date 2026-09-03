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

import type { BrowserStoragePolicy } from "@mcpjam/sdk/widget-runtime";
import {
  stableStringifyJson,
  buildOuterAllowAttribute,
  buildOuterSandboxAttribute,
} from "@mcpjam/sdk/widget-runtime";
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
import type { CspSubtypePolicy } from "./widget-host";

function isRecorderDebugEnabled() {
  try {
    return (
      typeof window !== "undefined" &&
      window.localStorage?.getItem("mcpjam:recorder-debug") === "1"
    );
  } catch {
    return false;
  }
}

function recorderDebug(message: string, details?: Record<string, unknown>) {
  try {
    if (isRecorderDebugEnabled()) {
      console.info(`[recorder:sandboxed-iframe] ${message}`, details ?? {});
    }
  } catch {
    // best-effort debug logging only
  }
}

/** The parts of `window.location` the sandbox origin is derived from. */
export type SandboxProxyLocation = Pick<
  Location,
  "hostname" | "port" | "protocol" | "origin"
>;

/**
 * The canonical origin a configured SANDBOX_ORIGIN names, or null when it
 * names none this iframe can load from.
 *
 * Comparing the configured string to `location.origin` directly misses every
 * value that spells the app's own origin differently — a trailing slash,
 * upper-case host, an explicit `:443`. Each one would have defeated the
 * distinct-origin check AND been spliced into the proxy URL as written. A
 * value that does not parse, or that carries a scheme no iframe can load, is
 * no better than an unset one.
 */
function parseSandboxOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return null;
  }
  return parsed.origin;
}

/**
 * Where the outer sandbox iframe loads from.
 *
 * SEP-1865: host and sandbox MUST have different origins.
 *
 * Hosted: prefer the operator-configured SANDBOX_ORIGIN
 * (`VITE_MCPJAM_SANDBOX_ORIGIN`). It MUST be a distinct origin from the host
 * app so the sandboxed iframe cannot reach host cookies or storage even when
 * its sandbox carries `allow-same-origin`.
 *
 * A configured origin EQUAL to the app's own counts as unset. It produces
 * exactly the same same-origin iframe as no value at all, and it is the more
 * likely of the two mistakes because it looks configured. The client boot
 * guard used to be the only thing that said so, and it could not tell that
 * case apart from the app legitimately being loaded on the sandbox hostname
 * (INSPECTOR-CLIENT-247) — so the deploy-level check moved to the server and
 * this renderer stopped walking straight through the condition.
 *
 * Local: keep the localhost ↔ 127.0.0.1 swap so dev gets the same
 * origin-separation property without operator config.
 *
 * Same-origin fallback exists only as a soft-fail for misconfigured hosted
 * deploys; it emits a loud security warning.
 */
/** A DNS label MCPJam derives for a server's dedicated view origin. */
const VIEW_ORIGIN_LABEL = /^[a-f0-9]{16}$/;

/**
 * Prefix `origin`'s host with a per-server label, or return null when this
 * browser would not resolve the result.
 *
 * Locally the label goes on `localhost`, which Chromium and Firefox resolve to
 * loopback for any subdomain. Safari does not, and a page that simply fails to
 * load is a worse outcome than sharing an origin, so it keeps the plain host.
 */
function labelledOrigin(
  origin: string,
  label: string,
  userAgent: string
): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (isLoopback) {
    const chromiumOrFirefox =
      /Chrome\/|Chromium\/|Firefox\//.test(userAgent) &&
      !/^((?!Chrome|Chromium).)*Safari/.test(userAgent);
    if (!chromiumOrFirefox) return null;
    // 127.0.0.1 has no subdomains; *.localhost does.
    url.hostname = `${label}.localhost`;
  } else {
    url.hostname = `${label}.${url.hostname}`;
  }
  return url.origin;
}

export function resolveSandboxProxyUrl({
  hostedMode,
  sandboxOrigin,
  location,
  viewOriginLabel,
  viewSubdomainsEnabled,
  userAgent,
}: {
  hostedMode: boolean;
  sandboxOrigin: string;
  location: SandboxProxyLocation;
  /** Per-server label; views share the sandbox origin without one. */
  viewOriginLabel?: string;
  viewSubdomainsEnabled?: boolean;
  userAgent?: string;
}): string {
  const proxyPath = hostedMode
    ? "/api/web/apps/mcp-apps/sandbox-proxy"
    : "/api/apps/mcp-apps/sandbox-proxy";

  // Only a label this code derived. Anything else — including a string a
  // server supplied — could name a host we do not control.
  const label =
    viewSubdomainsEnabled &&
    typeof viewOriginLabel === "string" &&
    VIEW_ORIGIN_LABEL.test(viewOriginLabel)
      ? viewOriginLabel
      : null;

  const configuredOrigin = hostedMode
    ? parseSandboxOrigin(sandboxOrigin)
    : null;
  if (configuredOrigin && configuredOrigin !== location.origin) {
    const perApp = label
      ? labelledOrigin(configuredOrigin, label, userAgent ?? "")
      : null;
    return `${perApp ?? configuredOrigin}${proxyPath}?v=${Date.now()}`;
  }

  const currentHost = location.hostname;
  const currentPort = location.port;
  const protocol = location.protocol;

  let sandboxHost: string;
  if (currentHost === "localhost") {
    sandboxHost = "127.0.0.1";
  } else if (currentHost === "127.0.0.1") {
    sandboxHost = "localhost";
  } else {
    if (hostedMode) {
      console.warn(
        "[SandboxedIframe] VITE_MCPJAM_SANDBOX_ORIGIN is not set to an origin" +
          " distinct from this app's; sandbox iframe is falling back to" +
          " same-origin. This is a security regression — the sandbox shares" +
          " cookies and storage with the host app. Configure a distinct origin" +
          " (e.g. https://sandbox.mcpjam.com) and redeploy."
      );
    } else {
      console.warn(
        "[SandboxedIframe] Cross-origin isolation not available for hostname:",
        currentHost,
        "- falling back to same-origin sandbox"
      );
    }
    sandboxHost = currentHost;
  }

  const portSuffix = currentPort ? `:${currentPort}` : "";
  const baseOrigin = `${protocol}//${sandboxHost}${portSuffix}`;
  const perApp = label
    ? labelledOrigin(baseOrigin, label, userAgent ?? "")
    : null;
  return `${perApp ?? baseOrigin}${proxyPath}?v=${Date.now()}`;
}

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
  /** Probe-derived host policy for individual CSP-backed browser APIs. */
  cspSubtypePolicy?: CspSubtypePolicy;
  /**
   * Probe-derived host policy for browser storage inside the widget.
   * Absent or `true` means available; `false` makes the proxy install a guard
   * that throws `SecurityError` on access, as a real iframe without
   * `allow-same-origin` does. Not a CSP concern — applies in permissive mode
   * too.
   */
  browserStorage?: BrowserStoragePolicy;
  /** Skip CSP injection entirely (for permissive/testing mode) */
  permissive?: boolean;
  /**
   * Tier 2 recorder: when true, the proxy injects a recorder shim into the
   * guest that posts `recorder:step` / `recorder:ready` messages (forwarded via
   * `onMessage`). Default off — only the eval authoring preview sets it.
   */
  recordMode?: boolean;
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
  /**
   * Whether the app runs against the hosted backend (the inspector's
   * `HOSTED_MODE`). Selects the hosted vs. local sandbox-proxy path and the
   * same-origin security warning. Supplied by the host (`host.surface.hostedMode`)
   * so this component carries no inspector config import.
   */
  hostedMode?: boolean;
  /**
   * Operator-configured sandbox origin (the inspector's `SANDBOX_ORIGIN` /
   * `VITE_MCPJAM_SANDBOX_ORIGIN`); "" when unset. Used in hosted mode to load
   * the sandbox proxy from a distinct origin. Supplied by the host
   * (`host.surface.sandboxOrigin`).
   */
  sandboxOrigin?: string;
  /**
   * How the proxy mounts the view: `"write"` (default) writes the HTML into a
   * blank same-origin iframe so the view runs at the proxy's URL; `"srcdoc"`
   * restores the legacy `iframe.srcdoc` mount, where the view has no URL of
   * its own. Supplied by the host (`host.surface.viewMountMode`); build-time
   * only, so it exists to exercise the srcdoc branch rather than to switch
   * behaviour at runtime.
   */
  mountMode?: "write" | "srcdoc";
  /**
   * Per-server label for a dedicated view origin, and whether this deploy
   * serves one. Supplied by the host; without both the view renders on the
   * shared sandbox origin.
   */
  viewOriginLabel?: string;
  viewSubdomainsEnabled?: boolean;
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
    cspSubtypePolicy,
    browserStorage,
    permissive,
    recordMode,
    onProxyReady,
    onMessage,
    className,
    style,
    colorScheme,
    title = "Sandboxed Content",
    hostedMode = false,
    sandboxOrigin = "",
    mountMode,
    viewOriginLabel,
    viewSubdomainsEnabled,
  },
  ref
) {
  const outerRef = useRef<HTMLIFrameElement>(null);
  const [proxyReady, setProxyReady] = useState(false);
  const lastResourceReadyKeyRef = useRef<string | null>(null);
  const onMessageRef = useRef(onMessage);
  const onProxyReadyRef = useRef(onProxyReady);
  onMessageRef.current = onMessage;
  onProxyReadyRef.current = onProxyReady;

  // Recomputed only when an input that changes the ORIGIN changes. It cannot
  // be a plain derivation: the URL carries a `?v=` cache-buster, so
  // recomputing every render would hand the iframe a new `src` each time and
  // reload the widget continuously. And it cannot be a one-shot initializer
  // either: `viewOriginLabel` arrives with the widget-content response, after
  // this component has already mounted, so a one-shot value would leave every
  // view on the shared origin forever.
  const sandboxProxyUrl = useMemo(
    () =>
      resolveSandboxProxyUrl({
        hostedMode,
        sandboxOrigin,
        location: window.location,
        viewOriginLabel,
        viewSubdomainsEnabled,
        userAgent:
          typeof navigator === "undefined" ? "" : navigator.userAgent,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hostedMode, sandboxOrigin, viewOriginLabel, viewSubdomainsEnabled]
  );

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
    [sandboxProxyOrigin]
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (event.origin !== sandboxProxyOrigin && sandboxProxyOrigin !== "*") {
        return;
      }
      if (event.source !== outerRef.current?.contentWindow) return;

      // CSP violation messages (not JSON-RPC) - forward directly
      if (event.data?.type === "mcp-apps:csp-violation") {
        onMessageRef.current(event);
        return;
      }

      // Whitelisted OpenAI compat messages (not JSON-RPC) - forward directly
      if (
        event.data?.type === "openai:uploadFile" ||
        event.data?.type === "openai:getFileDownloadUrl" ||
        event.data?.type === "openai:setWidgetState" ||
        event.data?.type === "openai:setOpenInAppUrl"
      ) {
        onMessageRef.current(event);
        return;
      }

      // Where the proxy mounted the view (not JSON-RPC) — carries the view's
      // real document URL, which the Sandbox Stack panel surfaces so a
      // developer can allowlist it with a referrer-restricted third party.
      if (event.data?.type === "mcpjam:view-mode") {
        onMessageRef.current(event);
        return;
      }

      // Tier 2 recorder messages (not JSON-RPC) — forward to the host so the
      // eval authoring preview can capture recorded steps / detect readiness,
      // and receive per-step results from a host-driven replay.
      if (
        event.data?.type === "recorder:step" ||
        event.data?.type === "recorder:ready" ||
        event.data?.type === "recorder:replay-result"
      ) {
        recorderDebug(`forward ${event.data.type}`);
        onMessageRef.current(event);
        return;
      }

      const { jsonrpc, method } =
        (event.data as { jsonrpc?: string; method?: string }) || {};
      if (jsonrpc !== "2.0") return;

      if (method === "ui/notifications/sandbox-proxy-ready") {
        setProxyReady(true);
        onProxyReadyRef.current?.();
        return;
      }

      if (method?.startsWith("ui/notifications/sandbox-")) {
        return;
      }

      onMessageRef.current(event);
    },
    [sandboxProxyOrigin]
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
  const outerAllowAttribute = useMemo(
    () => buildOuterAllowAttribute({ permissions, allowFeatures }),
    [permissions, allowFeatures]
  );

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
  const outerSandboxAttribute = useMemo(
    () => buildOuterSandboxAttribute({ sandbox, sandboxAttrs }),
    [sandbox, sandboxAttrs]
  );

  const resourceReadyKey = useMemo(
    () =>
      stableStringifyJson({
        csp: csp ?? null,
        cspDirectives: cspDirectives ?? null,
        cspSubtypePolicy: cspSubtypePolicy ?? null,
        browserStorage: browserStorage ?? null,
        html: html ?? null,
        permissive: permissive ?? null,
        permissions: permissions ?? null,
        sandbox,
        sandboxAttrs: sandboxAttrs ?? null,
        // Include recordMode so record-capable surfaces receive the recorder
        // shim, and stale/non-recordable surfaces reload without it.
        recordMode: recordMode ?? null,
        // Part of the render recipe: it decides how the proxy mounts the HTML,
        // so a change must re-send rather than leave the previous mount up.
        mountMode: mountMode ?? null,
      }),
    [
      csp,
      cspDirectives,
      cspSubtypePolicy,
      browserStorage,
      html,
      permissive,
      permissions,
      sandbox,
      sandboxAttrs,
      recordMode,
      mountMode,
    ]
  );

  useEffect(() => {
    if (!proxyReady) lastResourceReadyKeyRef.current = null;
  }, [proxyReady]);

  // Send HTML, CSP, and permissions to sandbox when ready (SEP-1865)
  useEffect(() => {
    if (!proxyReady || !html) return;
    const resourceTargetKey = `${sandboxProxyOrigin}\0${resourceReadyKey}`;
    if (lastResourceReadyKeyRef.current === resourceTargetKey) return;
    lastResourceReadyKeyRef.current = resourceTargetKey;

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
          cspSubtypePolicy,
          browserStorage,
          permissive,
          colorScheme,
          recordMode,
          recorderDebug: isRecorderDebugEnabled(),
          mountMode,
        },
      },
      sandboxProxyOrigin
    );
    recorderDebug("sent resource ready", {
      recordMode: !!recordMode,
      recorderDebug: isRecorderDebugEnabled(),
      proxyReady,
      hasHtml: !!html,
      sandboxProxyOrigin,
    });
    // This effect intentionally depends on the semantic payload key instead
    // of raw object props. Re-sending `sandbox-resource-ready` makes the
    // proxy assign inner `srcdoc` again, which restarts the app even when the
    // HTML/CSP/permission payload is unchanged.
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
  }, [proxyReady, html, resourceReadyKey, sandboxProxyOrigin]);

  // Keep iframe color-scheme in sync without reloading the widget document.
  useEffect(() => {
    if (!proxyReady || !colorScheme) return;

    outerRef.current?.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-color-scheme-changed",
        params: { colorScheme },
      },
      sandboxProxyOrigin
    );
  }, [proxyReady, colorScheme, sandboxProxyOrigin]);

  const iframeStyle = colorScheme ? { ...style, colorScheme } : style;

  // Browsers apply iframe `sandbox=` only on navigation, not when the
  // attribute mutates on an already-loaded frame. If the user edits a
  // profile from permissive tokens to `[]` while the widget is mounted,
  // React updates the attribute but the live iframe keeps the OLD
  // grants until something forces a navigation — so the matrix/editor
  // can show stricter modeling while the running widget still has
  // popups/forms/etc. enabled. Key the outer iframe on
  // outerSandboxAttribute so React unmounts + remounts (= fresh
  // navigation) whenever the effective sandbox flags change. Resetting
  // proxyReady below ensures the resource-ready effect re-fires after
  // the new proxy load completes (otherwise proxyReady would stay
  // `true` from the prior iframe and the widget wouldn't get re-sent
  // to the new proxy).
  useEffect(() => {
    setProxyReady(false);
  }, [outerSandboxAttribute, sandboxProxyOrigin]);

  return (
    <iframe
      // Remount on a changed origin as well as changed sandbox flags: an
      // <iframe> whose `src` changes navigates in place, and the proxy would
      // keep the state of whichever origin it loaded first.
      key={`${sandboxProxyOrigin}\u0000${outerSandboxAttribute}`}
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
