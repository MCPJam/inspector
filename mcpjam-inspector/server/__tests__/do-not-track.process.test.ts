/**
 * DO_NOT_TRACK and MCPJAM_FEATURE_FLAGS_FILE, proven on the real server.
 *
 * Each case boots `server/index.ts` in a child process under a deny-mode
 * network guard (`test/support/deny-network.mjs`) that records and refuses
 * every DNS lookup and socket connect to a non-loopback destination, then
 * uses it the way a browser would and shuts it down with SIGTERM.
 *
 * Opted out, nothing reaches PostHog or Sentry — not at boot, where hosted
 * mode reports its missing service credential through the logger; not in use,
 * where the browser asks for its flags and posts to the `/tlm` relay; and not
 * at shutdown, which flushes analytics — and the flags served come from the
 * flag file. The control boots the same server without the opt-out and shows
 * the guard sees PostHog and Sentry attempts, so silence above is a result
 * rather than a guard that sees nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  removeScratch,
  startGuardedServer,
  type GuardedServer,
  type NetworkAttempt,
} from "../test/support/guarded-server.js";

/** An anonymous posthog-js id (UUID v7), the identity `/api/web/flags` serves without a bearer. */
const VISITOR = "01926f5a-1c2b-7d3e-8f4a-5b6c7d8e9f01";

const FLAG_FILE = JSON.stringify({
  "evaluate-enabled": true,
  "guest-credit-wall-copy": "treatment",
  "registry-enabled": false,
  "not-a-client-flag": true,
});

const isTelemetryVendor = ({ target }: NetworkAttempt) =>
  /(^|\.)(posthog\.com|sentry\.io)$/i.test(target);

/** Use the server the way a browser does, touching every telemetry path. */
async function exercise(server: GuardedServer) {
  const get = (path: string, init?: RequestInit) =>
    fetch(`${server.baseUrl}${path}`, init);
  const document = await (await get("/")).text();
  const flags = await (
    await get(`/api/web/flags?distinct_id=${VISITOR}&platform=web`)
  ).json();
  const relay = await Promise.all([
    get("/tlm/static/array.js"),
    get("/relay/static/array.js"),
    get("/tlm/e/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: "$pageview", properties: {} }),
    }),
  ]);
  return {
    document,
    flags,
    relay: await Promise.all(
      relay.map(async (response) => ({
        status: response.status,
        body: await response.text(),
      })),
    ),
  };
}

describe("a hosted server under DO_NOT_TRACK", () => {
  let optedOut: GuardedServer;
  let control: GuardedServer;
  let optedOutUse: Awaited<ReturnType<typeof exercise>>;
  let optedOutBoot: NetworkAttempt[];
  let optedOutExit: number | null;
  let controlAttempts: NetworkAttempt[];

  beforeAll(async () => {
    [optedOut, control] = await Promise.all([
      startGuardedServer({
        env: {
          DO_NOT_TRACK: "1",
          MCPJAM_FEATURE_FLAGS_FILE: "flags.json",
        },
        files: { "flags.json": FLAG_FILE },
      }),
      startGuardedServer({}),
    ]);
    optedOutBoot = optedOut.attempts();
    optedOutUse = await exercise(optedOut);
    await exercise(control);
    optedOutExit = await optedOut.stop();
    await control.stop();
    controlAttempts = control.attempts();
  }, 180_000);

  afterAll(async () => {
    for (const server of [optedOut, control]) {
      if (!server) continue;
      await server.stop();
      removeScratch(server);
    }
  });

  it("reaches neither PostHog nor Sentry at boot, in use, or at shutdown", () => {
    expect(optedOutBoot.filter(isTelemetryVendor)).toEqual([]);
    expect(optedOutExit, optedOut.output()).toBe(0);
    expect(optedOut.attempts().filter(isTelemetryVendor)).toEqual([]);
  });

  it("refuses everything sent to the relay, on both mounts", () => {
    for (const response of optedOutUse.relay) {
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: "telemetry_disabled" });
    }
  });

  it("tells the browser through the runtime config it serves", () => {
    const runtimeConfig = /window\.__MCP_RUNTIME_CONFIG__=(\{.*?\});/.exec(
      optedOutUse.document,
    );
    expect(runtimeConfig, optedOutUse.document).not.toBeNull();
    expect(JSON.parse(runtimeConfig?.[1] ?? "null")).toMatchObject({
      doNotTrack: true,
    });
  });

  it("serves the flag file's answers, not PostHog's", () => {
    expect(optedOutUse.flags).toEqual({
      flags: {
        "evaluate-enabled": true,
        "guest-credit-wall-copy": "treatment",
        "registry-enabled": false,
      },
    });
  });

  it("control: without it, the guard sees the server reach PostHog and Sentry", () => {
    const vendors = controlAttempts.filter(isTelemetryVendor).map((a) => a.target);
    expect(vendors.some((host) => host.endsWith("posthog.com")), control.output()).toBe(true);
    expect(vendors.some((host) => host.endsWith("sentry.io")), control.output()).toBe(true);
  });
});
