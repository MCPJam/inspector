/**
 * BB-3 / BB-63. `group 1` is a name that says nothing about what is inside it.
 * Ignacio's report is the whole specification: "i'm uncomfortable with 'group1'
 * and can't change it" — and his screenshot shows a group called `group 1`
 * holding a server called `rabona`.
 *
 * Renaming is a separate fix (there is no update mutation yet). This is the
 * other half: a name derived from the contents means far fewer groups ever
 * need renaming.
 */
import { describe, expect, it } from "vitest";
import { deriveServerGroupName } from "../server-group-name";

describe("deriveServerGroupName", () => {
  it("names a single-server group after its server", () => {
    expect(deriveServerGroupName(["draw"], [])).toBe("draw");
  });

  it("names a multi-server group after the first, and counts the rest", () => {
    expect(deriveServerGroupName(["draw", "Notion", "Linear"], [])).toBe(
      "draw + 2"
    );
  });

  // Nothing picked yet is the one case with nothing to derive from, so the
  // numbered fallback survives — it just stops being the DEFAULT.
  it("falls back to a numbered name when nothing is picked", () => {
    expect(deriveServerGroupName([], [])).toBe("group 1");
  });

  it("takes the lowest free number for the fallback", () => {
    expect(deriveServerGroupName([], ["group 1", "group 3"])).toBe("group 2");
  });

  it("disambiguates a derived name that is already taken", () => {
    expect(deriveServerGroupName(["draw"], ["draw"])).toBe("draw 2");
  });

  it("keeps counting while the suffixed names are taken too", () => {
    expect(deriveServerGroupName(["draw"], ["draw", "draw 2"])).toBe("draw 3");
  });

  it("matches existing names case-insensitively and ignores their padding", () => {
    expect(deriveServerGroupName(["draw"], ["  DRAW  "])).toBe("draw 2");
  });

  it("ignores a blank server name rather than producing an empty group name", () => {
    expect(deriveServerGroupName(["   "], [])).toBe("group 1");
  });
});
