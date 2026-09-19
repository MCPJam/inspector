import { describe, expect, it } from "vitest";
import { dependentFilterOptions } from "../filter-options";

const rows = [
  { platform: "ui", client: "Claude", servers: ["A", "B"] },
  { platform: "sdk", client: "Cursor", servers: ["C"] },
  { platform: "sdk", client: "Claude", servers: ["D"] },
];
function options(
  platform: string[] = [],
  client: string[] = [],
  server: string[] = [],
  data = rows,
) {
  return dependentFilterOptions(data, {
    platform: { selected: platform, values: (row) => [row.platform] },
    client: { selected: client, values: (row) => [row.client] },
    server: { selected: server, values: (row) => row.servers },
  });
}
describe("dependent filter options", () => {
  it("narrows other facets while leaving alternatives in the selected facet", () => {
    expect(options(["ui"])).toEqual({
      platform: ["sdk", "ui"],
      client: ["Claude"],
      server: ["A", "B"],
    });
    expect(options(["sdk"], ["Claude"])).toEqual({
      platform: ["sdk", "ui"],
      client: ["Claude", "Cursor"],
      server: ["D"],
    });
  });
  it("uses OR within a multi-select and AND across filters", () => {
    expect(options(["ui", "sdk"], ["Claude"]).server).toEqual(["A", "B", "D"]);
    expect(options([], [], ["C"]).client).toEqual(["Cursor"]);
  });
  it("preserves selected values when live data disappears", () => {
    expect(options(["ui"], ["Claude"], ["A"], [])).toEqual({
      platform: ["ui"],
      client: ["Claude"],
      server: ["A"],
    });
  });
  it("restores available choices after clearing", () => {
    expect(options().client).toEqual(["Claude", "Cursor"]);
    expect(options().server).toEqual(["A", "B", "C", "D"]);
  });
});
