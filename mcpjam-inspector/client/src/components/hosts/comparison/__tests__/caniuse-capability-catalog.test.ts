import { describe, expect, it } from "vitest";
import {
  CANIUSE_CAPABILITIES,
  CANIUSE_LAST_VERIFIED_DATE,
  PUBLIC_CAN_I_USE_FIELDS,
  buildCaniuseCapabilityPath,
  getCaniuseCapabilityForField,
  getCaniuseCapabilityBySlug,
  getCaniuseSupportLabel,
  getCaniuseSupportLevel,
  caniuseFieldHasPresetData,
  publicCaniuseFieldsWithData,
} from "../caniuse-capability-catalog";
import { emptyHostConfigInputV2 } from "@/lib/client-config-v2";
import {
  hostConfigField,
  type HostComparisonSubject,
} from "@/lib/host-config-field-schema";

describe("caniuse capability catalog", () => {
  it("includes stable public capability slugs", () => {
    expect(getCaniuseCapabilityBySlug("sampling")?.field.id).toBe(
      "capabilities.sampling"
    );
    expect(getCaniuseCapabilityBySlug("elicitation")?.field.id).toBe(
      "capabilities.elicitation"
    );
    expect(getCaniuseCapabilityBySlug("roots")?.field.id).toBe(
      "capabilities.roots"
    );
    expect(
      getCaniuseCapabilityBySlug("mcp-apps-available-display-modes")?.field.id
    ).toBe("appsCap.availableDisplayModes");
    expect(
      getCaniuseCapabilityForField(hostConfigField("capabilities.elicitation"))
        ?.slug
    ).toBe("elicitation");
  });

  it("includes every CSP subtype as its own capability row", () => {
    const ids = PUBLIC_CAN_I_USE_FIELDS.map((field) => field.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "appsCap.cspConnectDomains.fetch",
        "appsCap.cspConnectDomains.xhr",
        "appsCap.cspConnectDomains.websocket",
        "appsCap.cspResourceDomains.script",
        "appsCap.cspResourceDomains.stylesheet",
        "appsCap.cspResourceDomains.image",
        "appsCap.cspResourceDomains.font",
        "appsCap.cspResourceDomains.media",
        "appsCap.cspFrameDomains",
        "appsCap.cspBaseUriDomains",
      ])
    );
  });

  it("includes the widget tool-result and sandbox storage probe rows", () => {
    const ids = PUBLIC_CAN_I_USE_FIELDS.map((field) => field.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "toolResult.structuredContent",
        "toolResult.content.text",
        "toolResult.content.resourceLink",
        "sandbox.browserStorage.localStorage",
        "sandbox.browserStorage.sessionStorage",
        "sandbox.browserStorage.indexedDB",
      ])
    );

    const config = emptyHostConfigInputV2() as never;
    expect(
      getCaniuseSupportLevel(
        hostConfigField("toolResult.structuredContent"),
        config
      )
    ).toBe("unknown");
    expect(getCaniuseSupportLabel("unknown")).toBe("Not yet tested");
  });

  it("publishes pagination as a yes/no row, unknown until probed", () => {
    const ids = PUBLIC_CAN_I_USE_FIELDS.map((field) => field.id);
    expect(ids).toContain("paginationTraversal");

    const field = hostConfigField("paginationTraversal");
    const withValue = (value: string) =>
      ({
        ...emptyHostConfigInputV2(),
        mcpProfile: { profileVersion: 1, paginationTraversal: value },
      }) as never;

    // Binary by design: a client either follows nextCursor or stops at page
    // one. There is no partial state to render.
    expect(getCaniuseSupportLevel(field, withValue("full"))).toBe("supported");
    expect(getCaniuseSupportLevel(field, withValue("firstPageOnly"))).toBe(
      "unsupported"
    );

    // A host nobody probed must never be published as failing.
    expect(
      getCaniuseSupportLevel(field, emptyHostConfigInputV2() as never)
    ).toBe("unknown");
  });

  it("excludes config-only fields from public capability pages", () => {
    const ids = PUBLIC_CAN_I_USE_FIELDS.map((field) => field.id);
    expect(ids).not.toContain("modelId");
    expect(ids).not.toContain("temperature");
    expect(ids).not.toContain("systemPrompt");
    expect(ids).not.toContain("clientInfo.name");
    expect(ids).not.toContain("connectionDefaults.headers");
    expect(ids).not.toContain("connectionDefaults.requestTimeout");
  });

  it("keeps slugs unique and path-safe", () => {
    const slugs = CANIUSE_CAPABILITIES.map((capability) => capability.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs.every((slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))).toBe(
      true
    );
    expect(buildCaniuseCapabilityPath("sampling")).toBe(
      "/capabilities/sampling"
    );
  });

  it("uses a static latest verification date for v1", () => {
    expect(CANIUSE_LAST_VERIFIED_DATE).toBe("2026-08-14");
  });
});

describe("unmeasured rows stay off the public surface", () => {
  const field = hostConfigField("toolCallCancellation");

  const subjectWith = (
    toolCallCancellation?: boolean
  ): Record<string, HostComparisonSubject> => ({
    "preset:claude": {
      hostName: "Claude",
      config: {
        ...emptyHostConfigInputV2(),
        id: "preset:claude",
        schemaVersion: 2,
        mcpProfile: {
          profileVersion: 1,
          ...(toolCallCancellation !== undefined
            ? { toolCallCancellation }
            : {}),
        },
      },
    } as HostComparisonSubject,
  });

  it("hides a field no published host carries a value for", () => {
    expect(caniuseFieldHasPresetData(field, subjectWith())).toBe(false);
    expect(publicCaniuseFieldsWithData(subjectWith())).not.toContain(field);
  });

  it("shows it as soon as one host has a value", () => {
    // One real host is the whole bar — the row exists to be compared, and a
    // single measured column already answers the question for that host.
    expect(caniuseFieldHasPresetData(field, subjectWith(false))).toBe(true);
    expect(publicCaniuseFieldsWithData(subjectWith(false))).toContain(field);
  });

  it("reads an unmeasured host as not-yet-tested rather than unsupported", () => {
    // The enum would otherwise resolve to "neutral", which renders as "Not
    // supported" — publishing a claim about a host nobody probed.
    const config = subjectWith()["preset:claude"]!.config;
    expect(getCaniuseSupportLevel(field, config)).toBe("unknown");
    expect(getCaniuseSupportLabel("unknown")).toBe("Not yet tested");
  });
});
