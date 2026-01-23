# Double-Iframe Sandbox Architecture: Deep Dive

This document explains the security architecture MCPJam uses to safely render untrusted MCP App widgets per SEP-1865.

## Why Double-Iframe?

The core security requirement from SEP-1865:

> **"If the Host is a web page, it MUST wrap the Guest UI and communicate with it through an intermediate Sandbox proxy. The Host and the Sandbox MUST have different origins."**

A single iframe isn't enough because:
1. Same-origin iframes can access parent `window` properties
2. `sandbox` attribute alone doesn't provide origin isolation
3. CSP injection requires control over the loading mechanism

The solution: **two nested iframes with different origins**.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        MCPJam Host Page                                 │
│                        Origin: http://localhost:5173                    │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                     MCPAppsRenderer (React)                       │  │
│  │                                                                   │  │
│  │  • Creates AppBridge                                              │  │
│  │  • Manages tool state                                             │  │
│  │  • Handles bridge callbacks                                       │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │                 SandboxedIframe (React)                     │  │  │
│  │  │                                                             │  │  │
│  │  │  • Computes cross-origin URL                                │  │  │
│  │  │  • Listens for sandbox-proxy-ready                          │  │  │
│  │  │  • Sends sandbox-resource-ready with HTML                   │  │  │
│  │  │                                                             │  │  │
│  └──│─────────────────────────────────────────────────────────────│──┘  │
│     │                                                             │     │
│     │  <iframe src="http://127.0.0.1:5173/api/mcp/sandbox-proxy"> │     │
│     │  sandbox="allow-scripts allow-same-origin allow-forms..."   │     │
│     │  allow="camera *; microphone *; ..."                        │     │
│     │                                                             │     │
└─────│─────────────────────────────────────────────────────────────│─────┘
      │                                                             │
      │  postMessage (JSON-RPC 2.0)                                 │
      ▼                                                             │
┌─────────────────────────────────────────────────────────────────────────┐
│                        Sandbox Proxy                                    │
│                        Origin: http://127.0.0.1:5173  ← DIFFERENT!      │
│                        File: sandbox-proxy.html                         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  JavaScript:                                                      │  │
│  │                                                                   │  │
│  │  1. Send sandbox-proxy-ready to parent                            │  │
│  │  2. Wait for sandbox-resource-ready                               │  │
│  │  3. Build CSP from metadata                                       │  │
│  │  4. Inject CSP <meta> tag into HTML                               │  │
│  │  5. Create inner iframe with srcdoc                               │  │
│  │  6. Relay messages: Host ↔ Guest                                  │  │
│  │                                                                   │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │              Inner iframe (Guest UI)                        │  │  │
│  │  │              srcdoc="<!DOCTYPE html>..."                    │  │  │
│  │  │              sandbox="allow-scripts allow-same-origin..."   │  │  │
│  │  │              allow="camera *; microphone *; ..."            │  │  │
│  │  │                                                             │  │  │
│  │  │  • MCP App widget HTML                                      │  │  │
│  │  │  • CSP enforced via injected <meta> tag                     │  │  │
│  │  │  • Communicates via postMessage                             │  │  │
│  │  │                                                             │  │  │
│  │  └─────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Step-by-Step Flow

### Step 1: Origin Calculation (`sandboxed-iframe.tsx:90-109`)

The `SandboxedIframe` component computes a cross-origin URL by swapping `localhost` ↔ `127.0.0.1`:

```typescript
const [sandboxProxyUrl] = useState(() => {
  const currentHost = window.location.hostname;
  const currentPort = window.location.port;
  const protocol = window.location.protocol;

  let sandboxHost: string;
  if (currentHost === "localhost") {
    sandboxHost = "127.0.0.1";      // localhost → 127.0.0.1
  } else if (currentHost === "127.0.0.1") {
    sandboxHost = "localhost";       // 127.0.0.1 → localhost
  } else {
    // Production would need a sandbox subdomain
    throw new Error(
      "[SandboxedIframe] SEP-1865 violation: Cannot use same-origin sandbox."
    );
  }

  const portSuffix = currentPort ? `:${currentPort}` : "";
  return `${protocol}//${sandboxHost}${portSuffix}/api/mcp/sandbox-proxy?v=${Date.now()}`;
});
```

**Why this works:** `localhost` and `127.0.0.1` resolve to the same IP but are treated as **different origins** by browsers. This gives us cross-origin isolation without needing separate infrastructure.

**Example:**
- Host: `http://localhost:5173`
- Sandbox: `http://127.0.0.1:5173` ← Different origin!

---

### Step 2: Outer Iframe Creation (`sandboxed-iframe.tsx:213-222`)

The component renders an iframe pointing to the sandbox proxy:

```tsx
<iframe
  ref={outerRef}
  src={sandboxProxyUrl}
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  allow={outerAllowAttribute}  // "camera *; microphone *; geolocation *; clipboard-write *"
  title={title}
  className={className}
  style={style}
/>
```

**Sandbox attributes explained:**
| Attribute | Purpose |
|-----------|---------|
| `allow-scripts` | JavaScript can run |
| `allow-same-origin` | Needed for postMessage origin checks |
| `allow-forms` | Forms can submit |
| `allow-popups` | Can open new windows (for `ui/open-link`) |
| `allow-popups-to-escape-sandbox` | Popups aren't sandboxed |

**Permission Policy (`allow` attribute):**
```typescript
// sandboxed-iframe.tsx:182-189
const outerAllowAttribute = useMemo(() => {
  const allowList = ["local-network-access *", "midi *"];
  if (permissions?.camera) allowList.push("camera *");
  if (permissions?.microphone) allowList.push("microphone *");
  if (permissions?.geolocation) allowList.push("geolocation *");
  if (permissions?.clipboardWrite) allowList.push("clipboard-write *");
  return allowList.join("; ");
}, [permissions]);
```

---

### Step 3: Sandbox Proxy Loads (`sandbox-proxy.html:244-251`)

The sandbox proxy HTML immediately creates an inner iframe (before HTML arrives):

```javascript
// Create inner iframe immediately (before HTML arrives)
const inner = document.createElement("iframe");
inner.style = "width:100%; height:100%; border:none;";
// Default minimal sandbox before HTML arrives
inner.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
document.body.appendChild(inner);
```

Then it notifies the host that it's ready:

```javascript
// sandbox-proxy.html:313-320
window.parent.postMessage({
  jsonrpc: "2.0",
  method: "ui/notifications/sandbox-proxy-ready",
  params: {},
}, "*");
```

---

### Step 4: Host Receives Ready Signal (`sandboxed-iframe.tsx:130-174`)

The host listens for the ready signal:

```typescript
const handleMessage = useCallback((event: MessageEvent) => {
  // Verify origin
  if (event.origin !== sandboxProxyOrigin && sandboxProxyOrigin !== "*") {
    return;
  }
  // Verify source is our iframe
  if (event.source !== outerRef.current?.contentWindow) return;

  const { jsonrpc, method } = event.data || {};
  if (jsonrpc !== "2.0") return;

  // Handle sandbox proxy ready
  if (method === "ui/notifications/sandbox-proxy-ready") {
    setProxyReady(true);
    onProxyReady?.();
    return;
  }

  // Filter out sandbox-internal messages
  if (method?.startsWith("ui/notifications/sandbox-")) {
    return;
  }

  // Forward all other messages to parent handler
  onMessage(event);
}, [onMessage, onProxyReady, sandboxProxyOrigin]);
```

---

### Step 5: Host Sends HTML & CSP (`sandboxed-iframe.tsx:192-210`)

Once the proxy is ready, the host sends the widget HTML with CSP metadata:

```typescript
useEffect(() => {
  if (!proxyReady || !html) return;

  outerRef.current?.contentWindow?.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-resource-ready",
    params: {
      html,           // The widget HTML string
      sandbox,        // Sandbox attributes for inner iframe
      csp,            // { connectDomains, resourceDomains, frameDomains, baseUriDomains }
      permissions,    // { camera, microphone, geolocation, clipboardWrite }
      permissive      // Skip CSP injection entirely (testing mode)
    },
  }, sandboxProxyOrigin);
}, [proxyReady, html, sandbox, csp, permissions, permissive, sandboxProxyOrigin]);
```

---

### Step 6: Sandbox Proxy Builds CSP (`sandbox-proxy.html:93-181`)

The proxy builds a CSP string from the metadata:

```javascript
function buildCSP(csp) {
  // Per SEP-1865: If no CSP declared, use restrictive defaults
  if (!csp) {
    return [
      "default-src 'none'",
      "script-src 'unsafe-inline'",
      "style-src 'unsafe-inline'",
      "img-src data:",
      "font-src data:",
      "media-src data:",
      "connect-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join("; ");
  }

  // Sanitize domains to prevent injection
  const connectDomains = (csp.connectDomains || [])
    .map(sanitizeDomain)
    .filter(Boolean);
  const resourceDomains = (csp.resourceDomains || [])
    .map(sanitizeDomain)
    .filter(Boolean);
  const frameDomains = (csp.frameDomains || [])
    .map(sanitizeDomain)
    .filter(Boolean);
  const baseUriDomains = (csp.baseUriDomains || [])
    .map(sanitizeDomain)
    .filter(Boolean);

  // Build directive values
  const connectSrc = connectDomains.length > 0
    ? connectDomains.join(" ")
    : "'none'";
  const resourceSrc = resourceDomains.length > 0
    ? ["data:", "blob:", ...resourceDomains].join(" ")
    : "data: blob:";
  const frameSrc = frameDomains.length > 0
    ? frameDomains.join(" ")
    : "'none'";
  const baseUri = baseUriDomains.length > 0
    ? baseUriDomains.join(" ")
    : "'none'";

  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' " + resourceSrc,
    "style-src 'unsafe-inline' " + resourceSrc,
    "img-src " + resourceSrc,
    "font-src " + resourceSrc,
    "media-src " + resourceSrc,
    "connect-src " + connectSrc,
    "frame-src " + frameSrc,
    "object-src 'none'",
    "base-uri " + baseUri,
  ].join("; ");
}
```

**Domain sanitization** prevents CSP injection attacks:

```javascript
function sanitizeDomain(domain) {
  if (typeof domain !== "string") return "";
  // Remove characters that could break out of CSP or HTML attributes
  return domain.replace(/['"<>;]/g, "").trim();
}
```

---

### Step 7: CSP Injection into HTML (`sandbox-proxy.html:215-241`)

The CSP is injected as a `<meta>` tag, along with a violation listener:

```javascript
function injectCSP(html, cspValue) {
  const cspMeta = '<meta http-equiv="Content-Security-Policy" content="' + cspValue + '">';
  const violationListener = buildViolationListenerScript();
  const injection = cspMeta + violationListener;

  // Inject after <head> tag (or create one)
  if (html.includes("<head>")) {
    return html.replace("<head>", "<head>" + injection);
  } else if (html.includes("<html>")) {
    return html.replace("<html>", "<html><head>" + injection + "</head>");
  } else {
    // Prepend if no structure found
    return injection + html;
  }
}
```

**Violation listener** forwards CSP violations to the host for debugging:

```javascript
function buildViolationListenerScript() {
  return `<script>
document.addEventListener('securitypolicyviolation', function(e) {
  var violation = {
    type: 'mcp-apps:csp-violation',
    directive: e.violatedDirective,
    blockedUri: e.blockedURI,
    sourceFile: e.sourceFile || null,
    lineNumber: e.lineNumber || null,
    columnNumber: e.columnNumber || null,
    effectiveDirective: e.effectiveDirective,
    originalPolicy: e.originalPolicy,
    disposition: e.disposition,
    timestamp: Date.now()
  };
  console.warn('[MCP Apps CSP Violation]', violation.directive, ':', violation.blockedUri);
  window.parent.postMessage(violation, '*');
});
<\/script>`;
}
```

---

### Step 8: Inner Iframe Loading (`sandbox-proxy.html:254-306`)

The proxy receives the HTML and loads it into the inner iframe:

```javascript
window.addEventListener("message", async (event) => {
  if (event.source === window.parent) {
    // Message from host
    if (event.data?.method === "ui/notifications/sandbox-resource-ready") {
      const { html, sandbox, csp, permissions, permissive } = event.data.params || {};

      // Set sandbox attributes
      if (typeof sandbox === "string") {
        inner.setAttribute("sandbox", sandbox);
      }

      // Set Permission Policy
      const allowAttribute = buildAllowAttribute(permissions);
      if (allowAttribute) {
        inner.setAttribute("allow", allowAttribute);
      }

      // Load HTML with CSP
      if (typeof html === "string") {
        if (permissive) {
          // Testing mode: inject maximally permissive CSP
          const permissiveCsp = [
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob: filesystem: about:",
            "script-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
            // ... everything allowed
          ].join("; ");
          inner.srcdoc = injectCSP(html, permissiveCsp);
        } else {
          // Production: use widget-declared CSP
          const cspValue = buildCSP(csp);
          inner.srcdoc = injectCSP(html, cspValue);
        }
      }
    } else {
      // Forward other messages to inner iframe (guest UI)
      if (inner?.contentWindow) {
        inner.contentWindow.postMessage(event.data, "*");
      }
    }
  } else if (event.source === inner.contentWindow) {
    // Relay messages from inner (guest UI) to parent (host)
    window.parent.postMessage(event.data, "*");
  }
});
```

---

### Step 9: Message Relay

The sandbox proxy acts as a transparent relay for all JSON-RPC messages:

```
Host                     Sandbox Proxy                Guest UI
  │                           │                           │
  │  tools/call request       │                           │
  │──────────────────────────▶│──────────────────────────▶│
  │                           │                           │
  │                           │  tools/call response      │
  │◀──────────────────────────│◀──────────────────────────│
```

**Key behavior:**
- Messages from host → forwarded to inner iframe
- Messages from inner iframe → forwarded to host
- `ui/notifications/sandbox-*` messages are **not** forwarded (proxy-internal)

---

## Security Properties

### 1. Origin Isolation

```
Host origin:    http://localhost:5173
Sandbox origin: http://127.0.0.1:5173
Guest origin:   about:srcdoc (opaque origin)
```

The guest UI cannot:
- Access `window.parent.parent` (host window)
- Read host cookies or localStorage
- Make same-origin requests to host APIs

### 2. CSP Enforcement

The injected CSP `<meta>` tag restricts:

| Directive | Controls | Default |
|-----------|----------|---------|
| `connect-src` | fetch, XHR, WebSocket | `'none'` |
| `script-src` | JavaScript sources | `'unsafe-inline'` only |
| `style-src` | CSS sources | `'unsafe-inline'` only |
| `img-src` | Image sources | `data:` only |
| `font-src` | Font sources | `data:` only |
| `frame-src` | Nested iframes | `'none'` |
| `base-uri` | `<base>` tag | `'none'` |

### 3. Sandbox Attribute

The `sandbox` attribute on both iframes restricts:
- No top-level navigation
- No plugins
- No pointer lock
- No presentation API
- Forms must be explicitly allowed

### 4. Permission Policy

The `allow` attribute controls:

| Permission | Purpose |
|------------|---------|
| `camera *` | Camera access |
| `microphone *` | Microphone access |
| `geolocation *` | Location access |
| `clipboard-write *` | Clipboard write |

Only granted if widget declares need in `_meta.ui.permissions`.

---

## CSP Modes in MCPJam

MCPJam supports two CSP modes (controlled via UI Playground):

### Widget-Declared Mode (Production)

```typescript
// Uses CSP from _meta.ui.csp
const cspValue = buildCSP({
  connectDomains: ["https://api.example.com"],
  resourceDomains: ["https://cdn.example.com"]
});
```

### Permissive Mode (Development/Testing)

```typescript
// Allows everything - for debugging CSP issues
const permissiveCsp = "default-src * 'unsafe-inline' 'unsafe-eval' ...";
```

The mode is passed through the entire chain:

```
MCPAppsRenderer              Server                    SandboxedIframe           Sandbox Proxy
      │                        │                             │                        │
      │  POST /widget/store    │                             │                        │
      │  { cspMode: "..." }    │                             │                        │
      │───────────────────────▶│                             │                        │
      │                        │                             │                        │
      │  GET /widget-content   │                             │                        │
      │◀───────────────────────│                             │                        │
      │  { permissive: bool }  │                             │                        │
      │                        │                             │                        │
      │  props: { permissive } │                             │                        │
      │────────────────────────────────────────────────────▶│                        │
      │                        │                             │                        │
      │                        │                             │  sandbox-resource-ready│
      │                        │                             │  { permissive: bool }  │
      │                        │                             │───────────────────────▶│
      │                        │                             │                        │
      │                        │                             │                        │  if (permissive)
      │                        │                             │                        │    use permissive CSP
      │                        │                             │                        │  else
      │                        │                             │                        │    use widget CSP
```

---

## Debugging Flow

When a CSP violation occurs:

```
Guest UI                    Sandbox Proxy               Host
   │                             │                        │
   │  [fetch blocked by CSP]     │                        │
   │                             │                        │
   │  securitypolicyviolation    │                        │
   │  event fires                │                        │
   │                             │                        │
   │  postMessage(violation)     │                        │
   │────────────────────────────▶│                        │
   │                             │  postMessage(violation)│
   │                             │───────────────────────▶│
   │                             │                        │
   │                             │                        │  addCspViolation()
   │                             │                        │  to debug store
   │                             │                        │
   │                             │                        │  Show in CSP
   │                             │                        │  Debug Panel
```

The `CSPDebugPanel` component (`csp-debug-panel.tsx`) shows:
- Which directive was violated
- What URI was blocked
- Source file and line number
- Suggested fix (add domain to appropriate CSP field)

---

## Common CSP Issues and Fixes

| Issue | Symptom | Fix |
|-------|---------|-----|
| API calls blocked | `connect-src` violation | Add API domain to `csp.connectDomains` |
| Scripts not loading | `script-src` violation | Add CDN to `csp.resourceDomains` |
| Styles not loading | `style-src` violation | Add CDN to `csp.resourceDomains` |
| Fonts not loading | `font-src` violation | Add font CDN to `csp.resourceDomains` |
| Images not loading | `img-src` violation | Add image CDN to `csp.resourceDomains` |
| Iframes blocked | `frame-src` violation | Add domain to `csp.frameDomains` |

**Example fix in MCP server:**

```typescript
// Before (CSP violations)
server.registerResource({
  uri: "ui://my-app/widget",
  mimeType: "text/html;profile=mcp-app",
  // No CSP declared - restrictive defaults apply
});

// After (CSP configured)
server.registerResource({
  uri: "ui://my-app/widget",
  mimeType: "text/html;profile=mcp-app",
  _meta: {
    ui: {
      csp: {
        connectDomains: ["https://api.myservice.com"],
        resourceDomains: ["https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
        frameDomains: ["https://www.youtube.com"]
      }
    }
  }
});
```

---

## Key Files Reference

| File | Location | Purpose |
|------|----------|---------|
| `SandboxedIframe` | `client/src/components/ui/sandboxed-iframe.tsx` | React component, outer iframe management |
| `sandbox-proxy.html` | `server/routes/mcp/sandbox-proxy.html` | Proxy page, CSP injection, message relay |
| `MCPAppsRenderer` | `client/src/components/chat-v2/thread/mcp-apps-renderer.tsx` | Orchestrates rendering, AppBridge setup |
| `apps.ts` | `server/routes/mcp/apps.ts` | Server routes for widget storage/retrieval |
| `CSPDebugPanel` | `client/src/components/chat-v2/thread/csp-debug-panel.tsx` | CSP violation debugging UI |
| `widget-debug-store.ts` | `client/src/stores/widget-debug-store.ts` | Stores CSP violations and debug info |

---

## Production Considerations

For production deployments (not localhost):

1. **Sandbox subdomain:** Use `sandbox.example.com` for the proxy
2. **HTTPS:** Both origins must use HTTPS
3. **CORS:** Ensure sandbox proxy endpoint is accessible cross-origin
4. **CSP headers:** Consider adding HTTP CSP headers in addition to meta tags

Example nginx configuration:

```nginx
# Main app
server {
    server_name app.example.com;
    # ...
}

# Sandbox proxy (different origin)
server {
    server_name sandbox.example.com;

    location /api/mcp/sandbox-proxy {
        # Serve sandbox-proxy.html
        add_header Content-Security-Policy "...permissive for outer frame...";
    }
}
```

---

## Related Documentation

- [MCP_APPS_RENDERING.md](./MCP_APPS_RENDERING.md) - Complete rendering flow
- [SEP-1865 Specification](https://github.com/anthropics/anthropic-cookbook/blob/main/misc/sep-1865-mcp-apps.md) - Official spec
