import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_DESCRIPTORS } from "../harness-descriptors";

/** Adding a descriptor field means deciding what every harness says for it. */
const DESCRIPTOR_KEYS = [
  "controls",
  "credential",
  "displayName",
  "guest",
  "local",
  "mcpClient",
  "modelAccess",
  "orgKeys",
  "protocol",
  "reasoningEfforts",
  "runtimeVersion",
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
  });

  it("keeps brokered and own-account harnesses distinct", () => {
    if (descriptor.modelAccess === "broker") {
      expect(descriptor.credential).toBeNull();
      expect(descriptor.protocol).not.toBeNull();
    } else {
      expect(descriptor.credential?.env.trim()).toBeTruthy();
      expect(descriptor.orgKeys).toBe(false);
      expect(descriptor.protocol).toBeNull();
      expect(descriptor.local).toBe(false);
      expect(descriptor.guest).toBe(false);
    }
  });

  it("only admits an organization key when that path is qualified", () => {
    expect(descriptor.orgKeys).toBe(id !== "cursor");
  });
});
