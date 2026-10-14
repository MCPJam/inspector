// @vitest-environment-options {"url": "https://app.mcpjam.com/servers"}
import { afterEach, expect, it, vi } from "vitest";
import bootstrap from "../../app-bootstrap.tsx?raw";
import { installNetworkStub } from "./support/jsdom-network";

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
});

it("installs the live-policy transport before SDK imports in the app", () => {
  expect(
    bootstrap.indexOf('import "./lib/install-telemetry-transport";'),
  ).toBeGreaterThan(-1);
  expect(
    bootstrap.indexOf('import "./lib/install-telemetry-transport";'),
  ).toBeLessThan(bootstrap.indexOf('from "posthog-js/react"'));
});

it("rechecks fetch and XHR retries after policy tightens", async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const attempts: string[] = [];
  const network = installNetworkStub((request) => {
    if (!request.url.includes("/e/")) return { body: "{}" };
    attempts.push(request.headers["x-mcpjam-telemetry-policy"]);
    return { status: attempts.length === 1 ? 503 : 200, body: "{}" };
  });
  const { installTelemetryTransport } =
    await import("@/lib/install-telemetry-transport");
  const restore = installTelemetryTransport();
  const { setSessionPrivacy } = await import("@/lib/session-privacy");
  const telemetry = await import("@/lib/telemetry-context");
  const actor = "user_01K00000000000000000000000";
  telemetry.setTelemetryActor(actor);
  telemetry.setTelemetryCaptureContext({
    projectIds: ["project_test"],
    organizationIds: [],
  });
  setSessionPrivacy("full");
  const posthog = (await import("posthog-js")).default;
  const clients: (typeof posthog)[] = [];
  try {
    for (const api_transport of ["fetch", "XHR"] as const) {
      attempts.length = 0;
      setSessionPrivacy("full");
      telemetry.setTelemetryContentPolicy(actor, "full");
      const client = posthog.init(
        "phc_test",
        {
          api_host: `${window.location.origin}/tlm`,
          api_transport,
          request_batching: false,
          disable_compression: true,
          capture_pageview: false,
          capture_pageleave: false,
          autocapture: false,
          disable_session_recording: true,
          disable_external_dependency_loading: true,
          advanced_disable_flags: true,
          persistence: "memory",
          before_send: (event) =>
            event?.event === "send_message"
              ? telemetry.stampPostHogEvent(event)
              : null,
        },
        `policy-${api_transport}`,
      )!;
      clients.push(client);
      client.opt_in_capturing();
      client.capture("send_message", {
        location: "chat_tab",
        prompt: "SENTINEL",
      });
      await vi.advanceTimersByTimeAsync(100);
      await network.settle();
      expect(attempts).toEqual(["full"]);
      telemetry.setTelemetryContentPolicy(actor, "strict");
      await vi.advanceTimersByTimeAsync(30_000);
      await network.settle();
      expect(attempts).toEqual(["full", "strict"]);
      // Unrelated app requests and user-supplied stale headers cannot widen it.
      await fetch("/tlm/e/", {
        headers: { "x-mcpjam-telemetry-policy": "full" },
      });
      expect(attempts.at(-1)).toBe("strict");
      await fetch("/api/data");
      expect(network.requests.at(-1)?.headers).not.toHaveProperty(
        "x-mcpjam-telemetry-policy",
      );
    }
    setSessionPrivacy("full");
    telemetry.setTelemetryActor(null);
    await fetch("/tlm/e/");
    expect(attempts.at(-1)).toBe("strict");
    telemetry.setTelemetryActor(actor);
    telemetry.setTelemetryCaptureContext({
      projectIds: ["project_test"],
      organizationIds: [],
      sharedLink: true,
    });
    await fetch("/tlm/e/");
    expect(attempts.at(-1)).toBe("strict");
  } finally {
    clients.forEach((client) => client.opt_out_capturing());
    restore();
    network.restore();
  }
});
