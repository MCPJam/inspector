import { TELEMETRY_POLICY_HEADER } from "../../../shared/strict-posthog";
import { currentTelemetryCaptureContext } from "./telemetry-context";

let restore: (() => void) | undefined;

/** Install before SDK imports: they retain fetch and XHR references. */
export function installTelemetryTransport(): () => void {
  if (restore) return restore;
  const matches = (input: string | URL) => {
    const url = new URL(input, window.location.href);
    return (
      url.origin === window.location.origin &&
      /^\/(tlm|relay)(\/|$)/.test(url.pathname)
    );
  };
  const livePolicy = () => currentTelemetryCaptureContext().policy.content;
  const originalFetch = window.fetch;
  const originalGlobalFetch = globalThis.fetch;
  const wrapped: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!matches(url)) return originalFetch.call(window, input, init);
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
  proto.open = function (
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ) {
    destinations.set(this, matches(String(url)));
    return open.call(this, method, url, async, username, password);
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
