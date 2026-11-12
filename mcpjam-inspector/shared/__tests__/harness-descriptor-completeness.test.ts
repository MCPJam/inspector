import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import {
  HARNESS_DESCRIPTORS,
  HARNESS_SURFACES,
  harnessSurfaceRefusal,
} from "../harness-descriptors";
import { orgKeySurfaceRefusal } from "../org-key-surfaces";

/** Adding a descriptor field means deciding what every harness says for it. */
const DESCRIPTOR_KEYS = [
  "controls",
  "credential",
  "displayName",
  "mcpClient",
  "modelAccess",
  "orgKeys",
  "protocol",
  "reasoningEfforts",
  "runtimeVersion",
  "unavailableOn",
];

const LOOP_CONTROLS = [
  "modelId",
  "progressiveToolDiscovery",
  "requireToolApproval",
  "temperature",
];

it("describes every SDK harness and nothing else", () => {
  expect(Object.keys(HARNESS_DESCRIPTORS).sort()).toEqual(
    [...HARNESS_IDS].sort(),
  );
});

describe.each(HARNESS_IDS)("%s descriptor", (id) => {
  const descriptor = HARNESS_DESCRIPTORS[id];

  it("carries exactly the agreed fields", () => {
    expect(Object.keys(descriptor).sort()).toEqual(DESCRIPTOR_KEYS);
    expect(Object.keys(descriptor.controls).sort()).toEqual(LOOP_CONTROLS);
  });

  it("uses only the known values", () => {
    expect(descriptor.displayName.trim()).not.toBe("");
    expect(descriptor.runtimeVersion.trim()).not.toBe("");
    expect(["harness", "mcpjam"]).toContain(descriptor.mcpClient);
    expect(["broker", "external-account"]).toContain(descriptor.modelAccess);
    for (const control of Object.values(descriptor.controls)) {
      if (!control.enforced) expect(control.note.trim()).not.toBe("");
    }
    for (const [surface, reason] of Object.entries(descriptor.unavailableOn)) {
      expect(HARNESS_SURFACES).toContain(surface);
      expect(reason).toMatch(/^[A-Z].+\.$/);
      // The backend's mirror pin captures surface/reason pairs, so each
      // reason names its runtime.
      expect(reason.startsWith(descriptor.displayName)).toBe(true);
    }
  });

  it("keeps brokered and own-account harnesses distinct", () => {
    if (descriptor.modelAccess === "broker") {
      expect(descriptor.credential).toBeNull();
      expect(descriptor.protocol).not.toBeNull();
    } else {
      expect(descriptor.credential?.env.trim()).toBeTruthy();
      expect(descriptor.orgKeys).toBe(false);
      expect(descriptor.protocol).toBeNull();
      expect(harnessSurfaceRefusal(id, "local")).toBeDefined();
      expect(harnessSurfaceRefusal(id, "guests")).toBeDefined();
      // Its boxes get the organization's key only in evals, swarms and the
      // Playground; the org-key checks enforce that with the same copy.
      const name = descriptor.displayName;
      expect(harnessSurfaceRefusal(id, "user-testing")).toBe(orgKeySurfaceRefusal(name, "study"));
      expect(harnessSurfaceRefusal(id, "api")).toBe(orgKeySurfaceRefusal(name, "elsewhere"));
      expect(harnessSurfaceRefusal(id, "events")).toBe(orgKeySurfaceRefusal(name, "elsewhere"));
    }
  });

  it("only admits an organization key when that path is qualified", () => {
    expect(descriptor.orgKeys).toBe(id !== "cursor");
  });
});
