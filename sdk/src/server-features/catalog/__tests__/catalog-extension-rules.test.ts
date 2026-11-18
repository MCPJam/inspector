import { describe, expect, it } from "vitest";
import { DRAFT_PROFILE_ID } from "../../../events/profiles.js";
import {
  fullCoverage,
  makeProbe,
  makeSurface,
} from "../../__tests__/fixtures.js";
import {
  MODERN,
  SKILLS_EXT,
  declared,
  feature,
  probed,
  type ProbeOverrides,
  type ProbeValues,
} from "./extension-rule-helpers.js";

describe("Skills", () => {
  const skill = {
    name: "pdf",
    description: "Read PDFs",
    uri: "skill://docs/pdf/SKILL.md",
  };

  it("reads the declaration, directoryRead and the resources co-declaration", () => {
    const surface = makeSurface({
      protocolVersion: MODERN,
      capabilities: {
        resources: {},
        extensions: { [SKILLS_EXT]: { directoryRead: true } },
      },
      skills: [skill],
      instructions: "Use the pdf skill for documents.",
    });
    expect(declared("skills.declaration", surface)).toEqual({
      kind: "present",
      via: "advertised",
      detail: "directoryRead: true",
    });
    expect(declared("skills.resources-capability", surface)).toMatchObject({
      kind: "present",
    });
    expect(declared("skills.directory-read", surface)).toMatchObject({
      kind: "present",
    });
    expect(declared("skills.list", surface)).toMatchObject({
      kind: "present",
      count: 1,
    });
    expect(declared("skills.uri-mapping", surface)).toMatchObject({
      kind: "present",
    });
    expect(declared("skills.instructions-pointer", surface)).toMatchObject({
      kind: "present",
    });
  });

  it("finds gaps only behind a complete capture", () => {
    const declaredOnly = makeSurface({
      protocolVersion: MODERN,
      capabilities: { extensions: { [SKILLS_EXT]: {} } },
    });
    expect(declared("skills.resources-capability", declaredOnly)).toEqual({
      kind: "absent",
      basis: ["capabilities"],
    });
    expect(declared("skills.directory-read", declaredOnly)).toEqual({
      kind: "absent",
      basis: ["capabilities"],
    });
    expect(declared("skills.instructions-pointer", declaredOnly)).toEqual({
      kind: "absent",
      basis: ["instructions", "capabilities"],
    });
    const none = makeSurface({
      protocolVersion: MODERN,
      capabilities: { extensions: {} },
    });
    expect(declared("skills.declaration", none)).toEqual({
      kind: "absent",
      basis: ["capabilities"],
    });
    expect(declared("skills.resources-capability", none)).toMatchObject({
      kind: "not-applicable",
    });
    // Before 2026-07-28 a missing id proves nothing.
    const older = makeSurface({
      protocolVersion: "2025-06-18",
      capabilities: { extensions: {} },
    });
    expect(declared("skills.declaration", older)).toMatchObject({
      kind: "unknown",
    });
    expect(declared("skills.resources-capability", older)).toBeNull();
  });

  it("never reads an empty skills/list as no skills, since skills/get serves unlisted ones", () => {
    const surface = makeSurface({
      protocolVersion: MODERN,
      capabilities: { extensions: { [SKILLS_EXT]: {} } },
      skills: [],
    });
    expect(declared("skills.list", surface)).toBeNull();
    expect(declared("skills.get", surface)).toBeNull();
    const badUri = makeSurface({
      skills: [{ name: "pdf", uri: "file:///pdf/SKILL.md" }],
    });
    expect(declared("skills.uri-mapping", badUri)).toMatchObject({
      kind: "unknown",
    });
  });

  it("reads listing and integrity from the skills probe", () => {
    const ok = {
      skills: makeProbe("skills", {
        listed: true,
        count: 3,
        verified: 3,
        digestFailures: 0,
        frontmatterFailures: 0,
      }),
    };
    expect(probed("skills.list", ok)).toEqual({
      kind: "present",
      via: "probed",
      count: 3,
    });
    expect(probed("skills.digest", ok)).toMatchObject({
      kind: "present",
      count: 3,
    });
    expect(probed("skills.frontmatter", ok)).toMatchObject({ kind: "present" });
    const bad = {
      skills: makeProbe("skills", {
        listed: true,
        count: 3,
        verified: 2,
        digestFailures: 1,
      }),
    };
    expect(probed("skills.digest", bad)).toMatchObject({ kind: "unknown" });
    expect(
      probed("skills.list", { skills: makeProbe("skills", { listed: false }) })
    ).toMatchObject({ kind: "unknown" });
    expect(
      probed("skills.list", {
        skills: makeProbe("skills", {}, { status: "not-applicable" }),
      })
    ).toMatchObject({
      kind: "not-applicable",
    });
  });
});

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

describe("Server Cards", () => {
  const card = (
    values: ProbeValues<"server-card">,
    overrides: ProbeOverrides<"server-card"> = {}
  ) => ({
    "server-card": makeProbe("server-card", values, overrides),
  });

  it("reads a published card field by field", () => {
    const probes = card({
      aiCatalogFound: true,
      catalogEntryFound: true,
      serverCardFound: true,
      serverCardUrl: "https://mcp.example.com/mcp/server-card",
      mediaTypeOk: true,
      requiredFieldsOk: true,
      optionalFields: ["title", "icons"],
      remotesListed: true,
      hasMeta: false,
      consistentWithRuntime: true,
      corsAllowed: true,
      cacheControl: true,
      https: true,
    });
    for (const id of [
      "server-cards.ai-catalog",
      "server-cards.catalog-entry",
      "server-cards.hosted-card",
      "server-cards.cors",
      "server-cards.https",
    ]) {
      expect(probed(id, probes), id).toMatchObject({
        kind: "present",
        via: "probed",
      });
    }
    expect(probed("server-cards.optional-fields", probes)).toMatchObject({
      count: 2,
      detail: "title, icons",
    });
    expect(probed("server-cards.meta", probes)).toEqual({
      kind: "absent",
      basis: [],
    });
  });

  it("shows a missing card once and skips its fields", () => {
    const probes = card({ aiCatalogFound: false, serverCardFound: false });
    expect(probed("server-cards.ai-catalog", probes)).toEqual({
      kind: "absent",
      basis: [],
    });
    expect(probed("server-cards.hosted-card", probes)).toEqual({
      kind: "absent",
      basis: [],
    });
    expect(probed("server-cards.catalog-entry", probes)).toMatchObject({
      kind: "not-applicable",
    });
    expect(probed("server-cards.required-fields", probes)).toMatchObject({
      kind: "not-applicable",
    });
  });

  it("keeps a card that conflicts with runtime advisory and names missing fields", () => {
    const probes = card({
      serverCardFound: true,
      consistentWithRuntime: false,
      requiredFieldsOk: false,
      missingFields: ["version"],
    });
    expect(probed("server-cards.runtime-consistency", probes)).toMatchObject({
      kind: "unknown",
    });
    expect(probed("server-cards.required-fields", probes)).toEqual({
      kind: "unknown",
      reason: "The card is missing version.",
    });
  });

  it("follows the probe status", () => {
    expect(
      probed("server-cards.ai-catalog", card({}, { status: "not-applicable" }))
    ).toMatchObject({ kind: "not-applicable" });
    expect(
      probed("server-cards.ai-catalog", card({}, { status: "failed" }))
    ).toMatchObject({ kind: "unknown" });
    expect(probed("server-cards.ai-catalog", {})).toBeNull();
    expect(
      probed(
        "server-cards.ai-catalog",
        card({ aiCatalogFound: false }, { coverage: "partial" })
      )
    ).toMatchObject({
      kind: "unknown",
    });
  });
});
