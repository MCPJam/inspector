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
import type { ConnectionStatus } from "@/state/app-types";
import { deriveServerGroupName, newGroupDraft } from "../server-group-name";

describe("deriveServerGroupName", () => {
  it("names a single-server group after its server", () => {
    expect(deriveServerGroupName(["draw"], [])).toBe("draw");
  });

  it("names a multi-server group after the first, and counts the rest", () => {
    expect(deriveServerGroupName(["draw", "Notion", "Linear"], [])).toBe(
      "draw + 2",
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

/**
 * BB-63, the "confusing inputs" half. The reported state is a create form with
 * ONE server available, that server unticked, `Servers (0 picked)`, and a dead
 * Create button. Every click in that form is a click whose answer was never in
 * doubt.
 *
 * So the draft arrives already answered when the pool is small enough that
 * there is only one sensible answer. Above that the guess would be wrong more
 * often than right, and an unasked-for selection is worse than an empty one.
 */
describe("newGroupDraft", () => {
  const pool = (...names: string[]) =>
    names.map((name, i) => ({ _id: `s-${i}`, name }));

  it("preselects the only server in a one-server project", () => {
    expect(newGroupDraft(pool("draw"), [])).toEqual({
      serverIds: ["s-0"],
      name: "draw",
    });
  });

  it("preselects a small pool whole, and names it after the contents", () => {
    expect(newGroupDraft(pool("draw", "Notion", "Linear"), [])).toEqual({
      serverIds: ["s-0", "s-1", "s-2"],
      name: "draw + 2",
    });
  });

  // Past a handful, "all of them" stops being the obvious answer, so we ask.
  it("preselects nothing once the pool is large enough to be a real choice", () => {
    expect(newGroupDraft(pool("a", "b", "c", "d"), [])).toEqual({
      serverIds: [],
      name: "group 1",
    });
  });

  it("has nothing to preselect in an empty project", () => {
    expect(newGroupDraft([], [])).toEqual({ serverIds: [], name: "group 1" });
  });

  it("avoids colliding with a group that already has the derived name", () => {
    expect(newGroupDraft(pool("draw"), ["draw"])).toEqual({
      serverIds: ["s-0"],
      name: "draw 2",
    });
  });
});

/**
 * Review finding 3. Ticking a server the run cannot reach walks the user from
 * the calm state into the amber one by doing what the form offered.
 */
describe("newGroupDraft leaves unreachable servers alone", () => {
  it("does not preselect a stdio server", () => {
    expect(
      newGroupDraft([{ _id: "s-0", name: "big-mcp", command: "uvx" }], []),
    ).toEqual({ serverIds: [], name: "group 1" });
  });

  it("does not preselect a loopback server", () => {
    expect(
      newGroupDraft(
        [{ _id: "s-0", name: "local", url: "http://localhost:3000/mcp" }],
        [],
      ),
    ).toEqual({ serverIds: [], name: "group 1" });
  });

  it("preselects only the reachable half of a mixed pool", () => {
    expect(
      newGroupDraft(
        [
          { _id: "s-0", name: "big-mcp", command: "uvx" },
          { _id: "s-1", name: "draw", url: "https://mcp.example.com/mcp" },
        ],
        [],
      ),
    ).toEqual({ serverIds: ["s-1"], name: "draw" });
  });
});

/**
 * BB-49. The same rule, now that the draft can see connection status: a server
 * whose last attempt FAILED builds a group that fails the moment it is
 * attached, so the form offers it and does not tick it.
 *
 * `disconnected` deliberately does NOT count. Every server reads disconnected
 * on a fresh load, so treating it as broken would empty the draft in exactly
 * the case BB-63 filled it.
 */
describe("newGroupDraft and connection status", () => {
  const remote = (name: string, status?: ConnectionStatus) => ({
    _id: `s-${name}`,
    name,
    url: `https://${name}.example.com/mcp`,
    ...(status ? { status } : {}),
  });

  it("does not preselect a server whose last connection failed", () => {
    expect(newGroupDraft([remote("test-bad-url", "failed")], [])).toEqual({
      serverIds: [],
      name: "group 1",
    });
  });

  it("preselects only the servers that have not failed", () => {
    expect(
      newGroupDraft(
        [remote("test-bad-url", "failed"), remote("draw", "connected")],
        [],
      ),
    ).toEqual({ serverIds: ["s-draw"], name: "draw" });
  });

  it("still preselects a disconnected server, which is every server on load", () => {
    expect(newGroupDraft([remote("draw", "disconnected")], [])).toEqual({
      serverIds: ["s-draw"],
      name: "draw",
    });
  });

  it("still preselects a server whose status is unknown", () => {
    expect(newGroupDraft([remote("draw")], [])).toEqual({
      serverIds: ["s-draw"],
      name: "draw",
    });
  });
});
