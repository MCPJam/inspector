import { liveTelemetryContentPolicy } from "./telemetry-transport-policy";
import { TELEMETRY_POLICY_HEADER } from "../../../shared/strict-posthog";
import { hasAnalyticsConsent } from "./analytics-consent";

// Event capture, session replay, logs and metrics: the relay subpaths that
// write into PostHog (server/routes/relay.ts `isIngestSubpath`).
const INGEST_PATH = /^\/(?:tlm|relay)\/(?:e|i\/v0\/e|s|i\/v1\/(?:logs|metrics))\/?$/;

// posthog-js keeps a batch it accepted before a withdrawal and sends it
// afterwards. Checking consent when it leaves stops that upload.
function withheldIngest(input: string | URL): boolean {
  if (hasAnalyticsConsent()) return false;
  try {
    return INGEST_PATH.test(new URL(input, window.location.href).pathname);
  } catch (error) {
    console.debug("[telemetry-transport] unparseable telemetry URL", error);
    return false;
  }
}

let restore: (() => void) | undefined;

/** Install before SDK imports: they retain fetch and XHR references. */
export function installTelemetryTransport(): () => void {
  if (restore) return restore;
  const matches = (input: string | URL) => {
    let url: URL;
    try {
      url = new URL(input, window.location.href);
    } catch {
      // Leave invalid app URLs to the browser implementation.
      return false;
    }
    return (
      url.origin === window.location.origin &&
      /^\/(tlm|relay)(\/|$)/.test(url.pathname)
    );
  };
  const livePolicy = liveTelemetryContentPolicy;
  const originalFetch = window.fetch;
  const originalGlobalFetch = globalThis.fetch;
  const wrapped: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!matches(url)) return originalFetch.call(window, input, init);
    // A success, so the SDK drops the batch instead of retrying it.
    if (withheldIngest(url)) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(TELEMETRY_POLICY_HEADER, livePolicy());
    return originalFetch.call(window, input, { ...init, headers });
  };
  window.fetch = wrapped;
  globalThis.fetch = wrapped;
  const proto = XMLHttpRequest.prototype;
  const open = proto.open;
  const send = proto.send;
  const setHeader = proto.setRequestHeader;
  const destinations = new WeakMap<XMLHttpRequest, boolean>();
  const urls = new WeakMap<XMLHttpRequest, string>();
  proto.open = function (
    _method: string,
    url: string | URL,
    _async: boolean = true,
    _username?: string | null,
    _password?: string | null,
  ) {
    destinations.set(this, matches(String(url)));
    urls.set(this, String(url));
    return Reflect.apply(open, this, arguments);
  };
  proto.setRequestHeader = function (name, value) {
    // Cached retry options must never override the current policy.
    if (
      destinations.get(this) &&
      name.toLowerCase() === TELEMETRY_POLICY_HEADER
    )
      return;
    return setHeader.call(this, name, value);
  };
  proto.send = function (body) {
    const url = urls.get(this);
    if (destinations.get(this) && url !== undefined && withheldIngest(url)) {
      this.abort();
      return;
    }
    if (destinations.get(this))
      setHeader.call(this, TELEMETRY_POLICY_HEADER, livePolicy());
    return send.call(this, body);
  };
  restore = () => {
    window.fetch = originalFetch;
    globalThis.fetch = originalGlobalFetch;
    proto.open = open;
    proto.send = send;
    proto.setRequestHeader = setHeader;
    restore = undefined;
  };
  return restore;
}

installTelemetryTransport();
