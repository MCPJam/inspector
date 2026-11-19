import { describe, expect, it } from "vitest";
import {
  computeArgumentsHash,
  computeBindingKey,
  computeControlKey,
  computeDeliveryKey,
  computeRunKey,
} from "../identity.js";

/**
 * The literal digests below are PINNED in three places that share no code:
 * this file, `events-inbox/test/identity.test.ts` and
 * `tests/convex/eventIdentity.test.ts` in mcpjam-backend. Changing a key's
 * composition changes every one of them — which is the point: a delivery key
 * the inbox computes differently from the registry silently double-schedules.
 */
const bindingKey = computeBindingKey({
  serverId: "srv_1",
  credentialOwnerUserId: "user_1",
  credentialFingerprint: null,
});
const base = {
  projectId: "proj_1",
  environmentId: null,
  bindingKey,
  logicalSubscriptionId: "esub_1",
};

describe("events identity (C2)", () => {
  it("pins the cross-runtime digests", () => {
    expect(bindingKey).toBe(
      "a53dbd56bcdde0a36163ff4e93273ed93f05675fb3880daf645e664525d9dea7"
    );
    expect(computeDeliveryKey({ ...base, eventId: "evt_1" })).toBe(
      "49ae844572c04ce0a222dc947197b4d2e06e898d6438d5d5d856c50898059bdb"
    );
    expect(computeControlKey({ ...base, webhookId: "msg_gap_1" })).toBe(
      "a6530fbaa491b23a0c18a9e62d0358143162eb40ac8382ddb162ef9a48cd22d4"
    );
    expect(
      computeRunKey({
        ...base,
        eventId: "evt_1",
        namespace: "live",
        triggerId: "trg_1",
      })
    ).toBe("7883b3f010b6dcd0398c74810ec34c1b4b2ae1ecdda4e84e1cab3adffe8c3f68");
    expect(
      computeRunKey({
        ...base,
        eventId: "evt_1",
        namespace: "simulation",
        triggerId: "trg_1",
      })
    ).toBe("e4692945e7a17df513f8b3059276ff97765fb1c853eb2731b24050c72baf5688");
  });

  it("does not collapse the same eventId across servers or subscriptions", () => {
    const otherServer = computeBindingKey({
      serverId: "srv_2",
      credentialOwnerUserId: "user_1",
      credentialFingerprint: null,
    });
    const a = computeDeliveryKey({ ...base, eventId: "evt_1" });
    const b = computeDeliveryKey({
      ...base,
      bindingKey: otherServer,
      eventId: "evt_1",
    });
    const c = computeDeliveryKey({
      ...base,
      logicalSubscriptionId: "esub_2",
      eventId: "evt_1",
    });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("gives every trigger its own run for one event", () => {
    const one = computeRunKey({
      ...base,
      eventId: "evt_1",
      namespace: "live",
      triggerId: "trg_1",
    });
    const two = computeRunKey({
      ...base,
      eventId: "evt_1",
      namespace: "live",
      triggerId: "trg_2",
    });
    expect(one).not.toBe(two);
  });

  it("keeps simulation and replay out of the live namespace", () => {
    const keys = (["live", "simulation", "replay:r1", "replay:r2"] as const).map(
      (namespace) =>
        computeRunKey({ ...base, eventId: "evt_1", namespace, triggerId: "t" })
    );
    expect(new Set(keys).size).toBe(4);
  });

  it("compares arguments by canonical JSON, not key order", () => {
    expect(computeArgumentsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(
      computeArgumentsHash({ b: { d: 3, c: 2 }, a: 1 })
    );
  });
});
