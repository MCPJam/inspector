import { describe, expect, it } from "vitest";
import {
  hasSameStringArray,
  resolveRestorableServerNames,
} from "../session-restore";

describe("session restore helpers", () => {
  it("maps saved server ids back to server names", () => {
    const serversById = new Map([
      ["server_1", "github"],
      ["server_2", "slack"],
    ]);

    expect(
      resolveRestorableServerNames(["server_1", "server_2"], serversById, [
        "github",
        "slack",
      ]),
    ).toEqual(["github", "slack"]);
  });

  it("keeps saved server names when they already match known names", () => {
    expect(
      resolveRestorableServerNames(
        ["github", "slack"],
        new Map<string, string>(),
        ["github", "slack"],
      ),
    ).toEqual(["github", "slack"]);
  });

  it("drops missing servers and de-duplicates restored names", () => {
    const serversById = new Map([
      ["server_1", "github"],
      ["server_2", "github"],
    ]);

    expect(
      resolveRestorableServerNames(
        ["missing", "server_1", "server_2", "github"],
        serversById,
        ["github"],
      ),
    ).toEqual(["github"]);
  });

  it("compares string arrays by value and order", () => {
    expect(hasSameStringArray(["a", "b"], ["a", "b"])).toBe(true);
    expect(hasSameStringArray(["a", "b"], ["b", "a"])).toBe(false);
    expect(hasSameStringArray(["a"], ["a", "b"])).toBe(false);
  });
});
