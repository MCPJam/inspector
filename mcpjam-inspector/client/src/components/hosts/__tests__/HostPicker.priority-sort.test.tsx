import { describe, expect, it } from "vitest";
import { orderHostsByPriority } from "@/components/hosts/HostPicker";
import type { HostListItem } from "@/hooks/useClients";

function makeHost(id: string, name: string): HostListItem {
  return {
    hostId: id,
    name,
    hostConfigId: `cfg-${id}`,
    modelId: "m",
    serverCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("orderHostsByPriority", () => {
  const hosts = [
    makeHost("h_a", "Alpha"),
    makeHost("h_b", "Bravo"),
    makeHost("h_c", "Charlie"),
  ];

  it("returns the input list unchanged when priorityHostId is undefined", () => {
    expect(orderHostsByPriority(hosts, undefined)).toBe(hosts);
  });

  it("floats priorityHostId to the front; rest keeps original order", () => {
    expect(
      orderHostsByPriority(hosts, "h_b").map((h) => h.hostId),
    ).toEqual(["h_b", "h_a", "h_c"]);
  });

  it("returns the input list unchanged when priorityHostId is already at index 0", () => {
    expect(orderHostsByPriority(hosts, "h_a")).toBe(hosts);
  });

  it("returns the input list unchanged when priorityHostId is not in the list", () => {
    expect(orderHostsByPriority(hosts, "h_unknown")).toBe(hosts);
  });

  it("handles single-element lists", () => {
    const single = [makeHost("h_a", "Alpha")];
    expect(orderHostsByPriority(single, "h_a")).toBe(single);
  });

  it("handles empty lists", () => {
    expect(orderHostsByPriority([], "h_a")).toEqual([]);
  });
});
