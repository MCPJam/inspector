import { describe, expect, it } from "vitest";
import { DRAFT_PROFILE_ID } from "../../../events/profiles.js";
import {
  fullCoverage,
  makeProbe,
  makeSurface,
} from "../../__tests__/fixtures.js";
import { declared, feature, probed } from "./extension-rule-helpers.js";

describe("Events", () => {
  it("accepts {} as a declaration and treats listChanged as a promise", () => {
    expect(
      declared(
        "events.capability",
        makeSurface({ capabilities: { events: {} } })
      )
    ).toMatchObject({ kind: "present" });
    const promised = makeSurface({
      capabilities: { events: { listChanged: true } },
    });
    expect(declared("events.list-changed", promised)).toMatchObject({
      kind: "unknown",
    });
    const explicitFalse = makeSurface({
      capabilities: { events: { listChanged: false } },
    });
    expect(declared("events.list-changed", explicitFalse)).toEqual({
      kind: "absent",
      basis: ["capabilities"],
    });
  });

  it("is a single gap when undeclared, and silent when capabilities are partial", () => {
    const none = makeSurface({ capabilities: { tools: {} } });
    expect(declared("events.capability", none)).toEqual({
      kind: "absent",
      basis: ["capabilities"],
    });
    expect(declared("events.stream", none)).toMatchObject({
      kind: "not-applicable",
    });
    expect(declared("events.webhook-subscribe", none)).toMatchObject({
      kind: "not-applicable",
    });
    const partial = makeSurface({
      capabilities: { tools: {} },
      coverage: fullCoverage({ capabilities: "partial" }),
    });
    expect(declared("events.stream", partial)).toBeNull();
  });

  it("reads delivery modes per server from events/list without judging a valid subset", () => {
    const probes = {
      "events-list": makeProbe("events-list", {
        listed: true,
        eventCount: 2,
        deliveryModes: ["webhook"],
      }),
    };
    expect(probed("events.list", probes)).toEqual({
      kind: "present",
      via: "probed",
      count: 2,
    });
    expect(probed("events.webhook-subscribe", probes)).toMatchObject({
      kind: "present",
    });
    expect(probed("events.poll", probes)).toMatchObject({
      kind: "absent",
      basis: [],
    });
    const partial = {
      "events-list": makeProbe(
        "events-list",
        { listed: true, deliveryModes: ["webhook"] },
        { coverage: "partial" }
      ),
    };
    expect(probed("events.stream", partial)).toBeNull();
  });

  it("records both error-code profiles and accepts either", () => {
    const summary = feature("events.error-codes").summary;
    expect(summary).toContain("-32011");
    expect(summary).toContain("-32023");
    expect(summary).toContain(DRAFT_PROFILE_ID);
    expect(feature("events.error-codes").assessment.observable).toBe(true);
    for (const id of [
      "events.endpoint-verification",
      "events.unsubscribe",
      "events.delivery-status",
    ]) {
      expect(feature(id).assessment.setup).toBe("event-webhook");
    }
  });
});
