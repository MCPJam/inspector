/**
 * Reading a host config's connection settings.
 *
 * Two callers depend on this being total and defensive: a swarm passes a pinned
 * snapshot the backend scrubbed, and an eval run passes whatever
 * `loadSuiteHostConfig` returned. Neither can afford a malformed stored value
 * to throw — that fails a launch over a field nobody was reading.
 */

import { describe, expect, it } from "vitest";
import {
  buildHostConnectionPins,
  hostClientCapabilities,
} from "../host-connection-pins.js";

const FALLBACK = 30_000;

describe("buildHostConnectionPins", () => {
  it("falls back to the caller's timeout when the host names none", () => {
    expect(buildHostConnectionPins({}, FALLBACK)).toEqual({
      timeoutMs: FALLBACK,
    });
  });

  it("reads the timeout under either wire spelling", () => {
    expect(
      buildHostConnectionPins(
        { connectionDefaults: { requestTimeout: 12_000 } },
        FALLBACK,
      ).timeoutMs,
    ).toBe(12_000);
    // A swarm snapshot spells it `timeoutMs`.
    expect(
      buildHostConnectionPins(
        { connectionDefaults: { timeoutMs: 9_000 } },
        FALLBACK,
      ).timeoutMs,
    ).toBe(9_000);
  });

  it("refuses a non-positive or non-finite timeout rather than pinning it", () => {
    for (const requestTimeout of [0, -1, Number.NaN, "30000", null]) {
      expect(
        buildHostConnectionPins(
          { connectionDefaults: { requestTimeout } },
          FALLBACK,
        ).timeoutMs,
        String(requestTimeout),
      ).toBe(FALLBACK);
    }
  });

  it("takes the initialize pins from mcpProfile, not connectionDefaults", () => {
    const pins = buildHostConnectionPins(
      {
        // The backend scrubs `connectionDefaults` down to a timeout, so a pin
        // parked here is not a pin — reading it from here always found nothing.
        connectionDefaults: {
          requestTimeout: 1_000,
          mcpProtocolVersion: "2025-11-25",
        },
        mcpProfile: {
          mcpProtocolVersion: "2026-07-28",
          initialize: {
            clientInfo: { name: "Claude", version: "1.2.3" },
            supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
          },
        },
      },
      FALLBACK,
    );
    expect(pins.initializePins).toEqual({
      clientInfo: { name: "Claude", version: "1.2.3" },
      supportedProtocolVersions: ["2026-07-28", "2025-11-25"],
      mcpProtocolVersion: "2026-07-28",
    });
  });

  it("drops an unknown protocol version instead of sending it", () => {
    const pins = buildHostConnectionPins(
      { mcpProfile: { mcpProtocolVersion: "2099-01-01" } },
      FALLBACK,
    );
    expect(pins.initializePins).toBeUndefined();
  });

  it("treats `auto` as no pin at all", () => {
    const pins = buildHostConnectionPins(
      { mcpProfile: { mcpProtocolVersion: "auto" } },
      FALLBACK,
    );
    expect(pins.initializePins).toBeUndefined();
  });

  it("reads per-server pins under either spelling, skipping malformed ones", () => {
    const pins = buildHostConnectionPins(
      {
        serverConnectionOverrides: {
          "srv-1": {
            mcpProtocolVersionOverride: "2025-11-25",
            requestTimeoutOverride: 5_000,
          },
          "srv-2": { mcpProtocolVersion: "2026-07-28", requestTimeout: 7_000 },
          "srv-3": {
            mcpProtocolVersionOverride: "nonsense",
            requestTimeoutOverride: -1,
          },
          "srv-4": "not-an-object",
        },
      },
      FALLBACK,
    );
    expect(pins.mcpProtocolVersionsByServerId).toEqual({
      "srv-1": "2025-11-25",
      "srv-2": "2026-07-28",
    });
    expect(pins.requestTimeoutByServerId).toEqual({
      "srv-1": 5_000,
      "srv-2": 7_000,
    });
  });

  it("survives every field being the wrong shape", () => {
    expect(() =>
      buildHostConnectionPins(
        {
          connectionDefaults: "nope",
          mcpProfile: 42,
          serverConnectionOverrides: ["not", "a", "map"],
          clientCapabilities: null,
        },
        FALLBACK,
      ),
    ).not.toThrow();
  });

  it("omits absent sections rather than emitting empty ones", () => {
    // An empty `initializePins: {}` would be a pin object saying nothing, and
    // callers spread it onto the wire.
    const pins = buildHostConnectionPins(
      { mcpProfile: { initialize: {} } },
      FALLBACK,
    );
    expect(pins).toEqual({ timeoutMs: FALLBACK });
  });
});

describe("hostClientCapabilities", () => {
  it("returns the host's declared set", () => {
    expect(
      hostClientCapabilities({
        clientCapabilities: { roots: {}, sampling: {} },
      }),
    ).toEqual({ roots: {}, sampling: {} });
  });

  it("reads an empty or absent set as 'no opinion', not as 'advertise nothing'", () => {
    // `createAuthorizedManager` reads undefined as "use the SDK defaults";
    // handing it `{}` would advertise no capabilities at all.
    expect(hostClientCapabilities({})).toBeUndefined();
    expect(hostClientCapabilities({ clientCapabilities: {} })).toBeUndefined();
    expect(
      hostClientCapabilities({ clientCapabilities: "nope" }),
    ).toBeUndefined();
  });
});
