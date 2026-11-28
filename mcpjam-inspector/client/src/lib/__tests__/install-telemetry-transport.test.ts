import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
const policy: { content: "full" | "strict" } = { content: "full" };
import { TELEMETRY_POLICY_HEADER } from "../../../../shared/strict-posthog";
let undo: (() => void) | undefined;
afterEach(() => { undo?.(); undo = undefined; vi.unstubAllGlobals(); vi.resetModules(); window.localStorage.clear(); });
async function install() {
  const fetch = vi.fn().mockResolvedValue(new Response("{}"));
  window.fetch = fetch;
  globalThis.fetch = fetch;
  const open = vi.fn(); const send = vi.fn(); const header = vi.fn(); const abort = vi.fn();
  class Xhr { open = open; send = send; setRequestHeader = header; abort = abort; }
  // Prototype methods are what browser SDKs cache.
  Xhr.prototype.open = open; Xhr.prototype.send = send; Xhr.prototype.setRequestHeader = header; Xhr.prototype.abort = abort;
  vi.stubGlobal("XMLHttpRequest", Xhr);
  const module = await import("../install-telemetry-transport");
  undo = module.installTelemetryTransport();
  (await import("../telemetry-transport-policy")).setTelemetryTransportPolicyReader(() => policy.content);
  return { fetch, open, send, header, abort, Xhr };
}

it("leaves normal app and external fetch inputs, options, headers and bodies untouched", async () => {
  const { fetch } = await install();
  for (const url of ["/api/web/chat-v2", "/relay-other", "https://external.example/relay/batch/"]) {
    const init = { method: "POST", body: "APP_BODY", headers: { [TELEMETRY_POLICY_HEADER]: "app-header", authorization: "APP_TOKEN" } };
    await window.fetch(url, init);
    expect(fetch).toHaveBeenLastCalledWith(url, init);
    expect(fetch.mock.calls.at(-1)?.[1]).toBe(init);
  }
  const request = new Request(`${window.location.origin}/api/web/chat-v2`, { method: "POST", body: "APP_BODY" });
  await window.fetch(request);
  expect(fetch).toHaveBeenLastCalledWith(request, undefined);
});

it("adds the live policy only to same-origin telemetry fetch destinations, including retries", async () => {
  const { fetch } = await install();
  const options = { method: "POST", body: "TELEMETRY", headers: { [TELEMETRY_POLICY_HEADER]: "full" } };
  // PostHog caches fetch during SDK initialization; retries must still read live policy.
  const sdkCachedFetch = window.fetch;
  policy.content = "strict";
  await sdkCachedFetch("/tlm/batch/", options);
  expect(new Headers(fetch.mock.calls.at(-1)?.[1].headers).get(TELEMETRY_POLICY_HEADER)).toBe("strict");
  policy.content = "full";
  await sdkCachedFetch("/relay/batch/", options);
  expect(new Headers(fetch.mock.calls.at(-1)?.[1].headers).get(TELEMETRY_POLICY_HEADER)).toBe("full");
  expect(options.headers[TELEMETRY_POLICY_HEADER]).toBe("full");
});

it("leaves app XHR calls untouched and stamps only telemetry send with live policy", async () => {
  const { open, send, header, Xhr } = await install();
  const app = Object.create(Xhr.prototype) as XMLHttpRequest;
  app.open("POST", "/api/web/chat-v2");
  app.setRequestHeader(TELEMETRY_POLICY_HEADER, "APP_VALUE");
  app.send("APP_BODY");
  expect(open).toHaveBeenCalledWith("POST", "/api/web/chat-v2");
  expect(header).toHaveBeenCalledOnce();
  expect(header).toHaveBeenCalledWith(TELEMETRY_POLICY_HEADER, "APP_VALUE");
  expect(send).toHaveBeenCalledWith("APP_BODY");
  header.mockClear();
  const telemetry = Object.create(Xhr.prototype) as XMLHttpRequest;
  telemetry.open("POST", "/tlm/batch/");
  telemetry.setRequestHeader(TELEMETRY_POLICY_HEADER, "full");
  policy.content = "strict";
  telemetry.send("TELEMETRY_BODY");
  expect(header).toHaveBeenCalledOnce();
  expect(header).toHaveBeenCalledWith(TELEMETRY_POLICY_HEADER, "strict");
});

it.each(["../../main.tsx", "../../app-bootstrap.tsx"])(
  "installs the telemetry guard before OAuth and SDK modules cache fetch (%s)", (entry) => {
    const source = readFileSync(new URL(entry, import.meta.url), "utf8");
    expect(source.match(/^import .*$/m)?.[0]).toBe('import "./lib/install-telemetry-transport";');
  },
);

it("holds back PostHog uploads queued before a withdrawal, and nothing else", async () => {
  const { fetch, send, abort, Xhr } = await install();
  window.__MCPJAM_ANALYTICS_CONSENT_REQUIRED__ = true;
  window.localStorage.setItem("mcpjam-analytics-consent", "denied");
  for (const path of ["/tlm/e/", "/tlm/s/?ver=1", "/relay/i/v0/e/"]) {
    const response = await window.fetch(path, { method: "POST", body: "QUEUED" });
    expect(response.status).toBe(204);
  }
  expect(fetch).not.toHaveBeenCalled();
  await window.fetch("/tlm/array/phc_key/config");
  expect(fetch).toHaveBeenCalledOnce();

  const queued = Object.create(Xhr.prototype) as XMLHttpRequest;
  queued.open("POST", "/tlm/e/");
  queued.send("QUEUED");
  expect(send).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledOnce();

  window.localStorage.setItem("mcpjam-analytics-consent", "granted");
  await window.fetch("/tlm/e/", { method: "POST", body: "ALLOWED" });
  expect(fetch).toHaveBeenCalledTimes(2);
});
