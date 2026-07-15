import { describe, expect, it } from "vitest";
import {
  CANIUSE_CAPABILITIES,
  CANIUSE_LAST_VERIFIED_DATE,
  PUBLIC_CAN_I_USE_FIELDS,
  buildCaniuseCapabilityPath,
  getCaniuseCapabilityForField,
  getCaniuseCapabilityBySlug,
} from "../caniuse-capability-catalog";
import { hostConfigField } from "@/lib/host-config-field-schema";

describe("caniuse capability catalog", () => {
  it("includes stable public capability slugs", () => {
    expect(getCaniuseCapabilityBySlug("sampling")?.field.id).toBe(
      "capabilities.sampling",
    );
    expect(getCaniuseCapabilityBySlug("elicitation")?.field.id).toBe(
      "capabilities.elicitation",
    );
    expect(getCaniuseCapabilityBySlug("roots")?.field.id).toBe(
      "capabilities.roots",
    );
    expect(
      getCaniuseCapabilityBySlug("mcp-apps-available-display-modes")?.field.id,
    ).toBe("appsCap.availableDisplayModes");
    expect(
      getCaniuseCapabilityForField(hostConfigField("capabilities.elicitation"))
        ?.slug,
    ).toBe("elicitation");
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
      true,
    );
    expect(buildCaniuseCapabilityPath("sampling")).toBe(
      "/capabilities/sampling",
    );
  });

  it("uses a static latest verification date for v1", () => {
    expect(CANIUSE_LAST_VERIFIED_DATE).toBe("2026-07-07");
  });
});
