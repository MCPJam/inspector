import { describe, expect, it } from "vitest";
import { getNewlyConnectedServers } from "../connected-server-auto-open";

describe("getNewlyConnectedServers", () => {
  it("does not treat the initial connected set as newly connected", () => {
    expect(
      getNewlyConnectedServers(null, new Set(["asana", "linear"])),
    ).toEqual([]);
  });

  it("returns only servers that were not connected previously", () => {
    expect(
      getNewlyConnectedServers(
        new Set(["asana"]),
        new Set(["asana", "linear"]),
      ),
    ).toEqual(["linear"]);
  });
});
