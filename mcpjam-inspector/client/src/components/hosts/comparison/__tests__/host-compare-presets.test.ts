import { describe, expect, it } from "vitest";
import { HOST_TEMPLATES } from "@/lib/client-templates";
import {
  PRESET_HOST_ID_PREFIX,
  buildPresetCompareEntries,
  isPresetHostId,
} from "../host-compare-presets";

describe("host-compare-presets", () => {
  it("builds one preset host + subject per template, in catalog order", () => {
    const { hosts, subjects } = buildPresetCompareEntries("dark");

    expect(hosts).toHaveLength(HOST_TEMPLATES.length);
    expect(hosts.map((h) => h.hostId)).toEqual(
      HOST_TEMPLATES.map((t) => `${PRESET_HOST_ID_PREFIX}${t.id}`),
    );
    // Every preset host has a matching, immediately-available subject.
    for (const host of hosts) {
      const subject = subjects[host.hostId];
      expect(subject).toBeDefined();
      expect(subject.hostName).toBe(host.name);
      expect(subject.config.modelId).toBe(host.modelId);
      // Synthetic DTO fields the matrix never reads but must be present.
      expect(subject.config.id).toBe(host.hostId);
    }
  });

  it("marks every preset id and rejects a real Convex id", () => {
    const { hosts } = buildPresetCompareEntries("light");
    expect(hosts.every((h) => isPresetHostId(h.hostId))).toBe(true);
    expect(isPresetHostId("k1234567890abcdef")).toBe(false);
  });
});
