/**
 * The decisions behind the two-tab server picker, kept out of the component.
 *
 * The design puts servers and server groups on sibling tabs instead of nesting
 * one inside the other. Storage does not change: every selection is still a
 * `serverAttachments` row. Picking a single server resolves to the row that
 * holds exactly that server — reusing one when it exists — so a bare server
 * needs no new column, and the rows minted that way stay off the Groups tab.
 *
 * Pure so the rules are testable without a popover and a Convex mock, the same
 * way `server-group-name.ts` and `cloud-server-readiness.ts` are.
 */
import { describe, expect, it } from "vitest";

import {
  findSoloGroup,
  isServerStandIn,
  initialPickerTab,
  listGroupsForTab,
  resolvePickerSelection,
  resolveServerConnection,
} from "../server-picker-model";

const group = (
  _id: string,
  name: string,
  serverIds: string[],
  resolvedServerNames: string[],
) => ({ _id, name, serverIds, resolvedServerNames });

const SOLO_ALPHA = group("g_alpha", "alpha", ["srv_1"], ["alpha"]);
const PAIR = group("g_pair", "alpha + 1", ["srv_1", "srv_2"], ["alpha", "beta"]);
const TRIO = group(
  "g_trio",
  "Group 3",
  ["srv_1", "srv_2", "srv_3"],
  ["alpha", "beta", "gamma"],
);

describe("listGroupsForTab", () => {
  it("hides a one-server row named after its server", () => {
    // That is the shape `findSoloGroup` mints for a bare server pick, so
    // listing it here would offer the same choice twice under two names.
    expect(listGroupsForTab([SOLO_ALPHA, PAIR, TRIO]).map((g) => g._id)).toEqual(
      ["g_pair", "g_trio"],
    );
  });

  it("KEEPS a one-server group the user named themselves", () => {
    // Both halves of the rule must hold. A group of one server called
    // something of its own is a deliberate group, not a server's stand-in.
    const named = group("g_x", "My prod server", ["srv_9"], ["prod"]);
    expect(listGroupsForTab([named, PAIR]).map((g) => g._id)).toEqual([
      "g_x",
      "g_pair",
    ]);
  });

  it("matches the name ignoring case and padding", () => {
    // Same normalization `deriveServerGroupName` uses for its collision
    // check — "Alpha" is still that server's stand-in.
    const padded = group("g_p", "  Alpha ", ["srv_1"], ["alpha"]);
    expect(listGroupsForTab([padded, PAIR]).map((g) => g._id)).toEqual([
      "g_pair",
    ]);
  });

  it("KEEPS a one-server row whose server name is unresolved", () => {
    // With no name to compare against, the rule cannot be evaluated. Fail
    // OPEN — hiding a row we cannot judge would strand it.
    const unresolved = group("g_u", "orphan", ["srv_7"], []);
    expect(listGroupsForTab([unresolved]).map((g) => g._id)).toEqual(["g_u"]);
  });

  it("keeps an empty group visible — it is not a server in disguise", () => {
    const empty = group("g_empty", "Group 9", [], []);
    expect(listGroupsForTab([empty])).toEqual([empty]);
  });
});

describe("rows persisted before `resolvedServerNames` existed", () => {
  // Four readers in the repo guard this field with `?? []`
  // (server-picker.tsx, generate-target-recency.ts, evals/helpers.ts ×2), so
  // it is absent at runtime on older rows. Indexing it bare throws, and these
  // run over every row on every render.
  const legacy = { _id: "g_l", name: "legacy", serverIds: ["srv_1"] } as any;

  it("does not throw when judging one", () => {
    expect(() => isServerStandIn(legacy)).not.toThrow();
    expect(isServerStandIn(legacy)).toBe(false);
  });

  it("keeps it listed instead of crashing the tab", () => {
    expect(() => listGroupsForTab([legacy])).not.toThrow();
    expect(listGroupsForTab([legacy]).map((g) => g._id)).toEqual(["g_l"]);
  });

  it("resolves it as a group, by its own name", () => {
    expect(() => resolvePickerSelection([legacy], "g_l")).not.toThrow();
    expect(resolvePickerSelection([legacy], "g_l")).toEqual({
      kind: "group",
      groupId: "g_l",
      label: "legacy",
      serverCount: 1,
    });
  });
});

describe("findSoloGroup", () => {
  it("finds the row that holds exactly this one server", () => {
    expect(findSoloGroup([PAIR, SOLO_ALPHA], "srv_1")).toBe(SOLO_ALPHA);
  });

  it("never returns a multi-server row that merely contains it", () => {
    // Reusing `alpha + 1` for a bare `alpha` pick would silently attach beta.
    expect(findSoloGroup([PAIR, TRIO], "srv_1")).toBeNull();
  });

  it("returns null when no row represents the server yet", () => {
    expect(findSoloGroup([PAIR], "srv_3")).toBeNull();
  });

  it("does NOT reuse a one-server group the user named", () => {
    // `group A` happens to hold this one server, but it is a group the user
    // made and named. Reusing it makes a click on the SERVER report the GROUP:
    // the trigger reads "group A" and the mark lands on the Groups tab. The
    // same stand-in rule the other readers use has to gate this one too.
    const named = group("g_a", "group A", ["srv_1"], ["alpha"]);
    expect(findSoloGroup([named], "srv_1")).toBeNull();
  });

  it("reuses a stand-in even when a named group holds the same server", () => {
    const named = group("g_a", "group A", ["srv_1"], ["alpha"]);
    expect(findSoloGroup([named, SOLO_ALPHA], "srv_1")).toBe(SOLO_ALPHA);
  });
});

describe("resolvePickerSelection", () => {
  it("reads a solo row as a SERVER selection, labelled with the server", () => {
    expect(resolvePickerSelection([SOLO_ALPHA, PAIR], "g_alpha")).toEqual({
      kind: "server",
      groupId: "g_alpha",
      serverId: "srv_1",
      label: "alpha",
    });
  });

  it("reads a multi-server row as a GROUP selection", () => {
    expect(resolvePickerSelection([SOLO_ALPHA, PAIR], "g_pair")).toEqual({
      kind: "group",
      groupId: "g_pair",
      label: "alpha + 1",
      serverCount: 2,
    });
  });

  it("reads a one-server group the USER named as a GROUP, not as a server", () => {
    // Both halves of the stand-in rule must hold here too, or selecting
    // `group A` reports the server it happens to hold: the trigger names
    // `big-mcp`, the Groups tab shows no mark, and the Servers tab marks a row
    // the user never picked. `listGroupsForTab` already applies both halves —
    // one criterion, two rules, is the bug.
    const named = group("g_a", "group A", ["srv_1"], ["alpha"]);
    expect(resolvePickerSelection([named], "g_a")).toEqual({
      kind: "group",
      groupId: "g_a",
      label: "group A",
      serverCount: 1,
    });
  });

  it("still reads a row NAMED AFTER its server as that server", () => {
    expect(resolvePickerSelection([SOLO_ALPHA], "g_alpha")).toEqual({
      kind: "server",
      groupId: "g_alpha",
      serverId: "srv_1",
      label: "alpha",
    });
  });

  it("opens the Groups tab for a user-named one-server group", () => {
    const named = group("g_a", "group A", ["srv_1"], ["alpha"]);
    expect(initialPickerTab(resolvePickerSelection([named], "g_a"))).toBe(
      "groups",
    );
  });

  it("reports a selection whose row is gone as dangling, not as absent", () => {
    // Today the trigger renders these identically to "nothing picked", so a
    // suite pointing at a deleted group reads as one that was never set up.
    expect(resolvePickerSelection([PAIR], "g_deleted")).toEqual({
      kind: "dangling",
      groupId: "g_deleted",
    });
  });

  it("returns null when nothing is selected", () => {
    expect(resolvePickerSelection([PAIR], null)).toBeNull();
  });

  it("reads a one-server row with NO resolvable name as a group", () => {
    // The stand-in rule needs a name to compare against. With none, it cannot
    // be judged — so this stays a group, exactly as `listGroupsForTab` keeps
    // it listed. One criterion, one answer, in both readers.
    const nameless = group("g_n", "orphan", ["srv_7"], []);
    expect(resolvePickerSelection([nameless], "g_n")).toEqual({
      kind: "group",
      groupId: "g_n",
      label: "orphan",
      serverCount: 1,
    });
  });
});

describe("initialPickerTab", () => {
  it("opens on Servers with nothing selected", () => {
    expect(initialPickerTab(null)).toBe("servers");
  });

  it("opens on Servers when a bare server is selected", () => {
    expect(initialPickerTab(resolvePickerSelection([SOLO_ALPHA], "g_alpha"))).toBe(
      "servers",
    );
  });

  it("opens on Groups when a group is selected", () => {
    // Matches the third artboard: a selected group shows the Groups tab.
    expect(initialPickerTab(resolvePickerSelection([PAIR], "g_pair"))).toBe(
      "groups",
    );
  });

  it("opens on Servers for a dangling selection — the tab it can be fixed on", () => {
    expect(initialPickerTab(resolvePickerSelection([], "g_gone"))).toBe(
      "servers",
    );
  });
});

describe("resolveServerConnection", () => {
  const runtime = (status: string) => ({ connectionStatus: status } as any);

  it("reports UNKNOWN when there is no runtime at all", () => {
    // Some surfaces mount the picker outside the server-actions provider. Not
    // knowing is not the same as being disconnected — painting a grey dot and
    // offering a Connect that goes nowhere would be a claim we cannot make.
    expect(resolveServerConnection("alpha", null)).toEqual({
      status: null,
      canConnect: false,
    });
  });

  it("treats a server the runtime has never seen as disconnected", () => {
    expect(resolveServerConnection("alpha", {})).toEqual({
      status: "disconnected",
      canConnect: true,
    });
  });

  it("offers Connect on disconnected and on FAILED", () => {
    // `failed` must not read like `disconnected` (BB-49) but it is equally
    // retryable, so the action stays.
    expect(resolveServerConnection("a", { a: runtime("disconnected") })).toEqual(
      { status: "disconnected", canConnect: true },
    );
    expect(resolveServerConnection("a", { a: runtime("failed") })).toEqual({
      status: "failed",
      canConnect: true,
    });
  });

  it("withholds Connect while a connection is already in flight", () => {
    // Two clicks on a connecting server would fire two handshakes.
    for (const status of ["connected", "connecting", "oauth-flow"]) {
      expect(resolveServerConnection("a", { a: runtime(status) })).toEqual({
        status,
        canConnect: false,
      });
    }
  });
});
