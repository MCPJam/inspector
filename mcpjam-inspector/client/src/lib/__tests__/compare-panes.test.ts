import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chipClientLimit,
  createPane,
  loadComparePanes,
  movePane,
  normalizePanes,
  paneHostIds,
  panesForHostIds,
  promoteLeadPane,
  saveComparePanes,
  subscribeComparePanes,
  syncLeadPane,
  type ComparePane,
} from "../compare-panes";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
} from "../previewed-client-storage";

const PROJECT = "p1";
const PROJECT_B = "p2";
const KEY_P1 = `mcp-inspector-compare-panes:${PROJECT}`;
const KEY_P2 = `mcp-inspector-compare-panes:${PROJECT_B}`;
const V1_KEY_P1 = `mcp-inspector-selected-hosts:${PROJECT}`;

const host = (hostId: string, paneId = hostId): ComparePane => ({
  paneId,
  target: { kind: "host", hostId },
});
const picked = {
  source: "hosted" as const,
  modelId: "openai/gpt-5.5",
  fallback: { provider: "none" as const, model: "none" as const },
};
const saveHosts = (projectId: string, hostIds: string[]) =>
  saveComparePanes(projectId, panesForHostIds([], hostIds));
const loadHosts = (projectId: string) =>
  paneHostIds(loadComparePanes(projectId));

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe("pane ids", () => {
  it("starts as the target's id and takes a suffix only when that id is taken", () => {
    expect(createPane({ kind: "host", hostId: "a" }, [])).toEqual(host("a"));
    expect(
      createPane({ kind: "host", hostId: "a" }, [
        host("b", "a"),
        host("a", "a~2"),
      ]),
    ).toEqual(host("a", "a~3"));
    expect(createPane({ kind: "environment", environmentId: "e" }, [])).toEqual(
      { paneId: "e", target: { kind: "environment", environmentId: "e" } },
    );
  });

  it("keeps a client's pane when a lineup of client ids reorders or grows", () => {
    const current = [host("a", "pane-a"), host("b", "pane-b")];
    expect(panesForHostIds(current, ["b", "a", "c"])).toEqual([
      host("b", "pane-b"),
      host("a", "pane-a"),
      host("c"),
    ]);
  });

  it("never gives a new pane an id that a pane being matched still holds", () => {
    // Pane "c" now runs client "z"; adding client "c" must not reuse its id.
    const current = [host("a"), host("z", "c")];
    expect(panesForHostIds(current, ["a", "c", "z"])).toEqual([
      host("a"),
      host("c", "c~2"),
      host("z", "c"),
    ]);
  });

  it("drops blank and repeated client ids and keeps at most three panes", () => {
    expect(
      paneHostIds(panesForHostIds([], [" a ", "", "a", "b", "c", "d"])),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("saved panes", () => {
  it("drops malformed panes and repeated ids, forgets invalid picks, keeps three", () => {
    expect(
      normalizePanes([
        host("a"),
        { paneId: "a", target: { kind: "host", hostId: "dup" } },
        { paneId: "x", target: { kind: "host", hostId: " " } },
        { paneId: "", target: { kind: "host", hostId: "b" } },
        { ...host("b"), pickedSelection: { source: "broken" } },
        { ...host("c"), pickedSelection: picked },
        host("d"),
      ]),
    ).toEqual([
      host("a"),
      host("b"),
      { ...host("c"), pickedSelection: picked },
    ]);
    expect(normalizePanes("nope")).toEqual([]);
  });

  it("round-trips per project and never leaks between projects", () => {
    saveComparePanes(PROJECT, [
      host("a"),
      { ...host("b"), pickedSelection: picked },
    ]);
    saveHosts(PROJECT_B, ["other"]);
    expect(loadComparePanes(PROJECT)).toEqual([
      host("a"),
      { ...host("b"), pickedSelection: picked },
    ]);
    expect(loadHosts(PROJECT_B)).toEqual(["other"]);
    expect(loadComparePanes(null)).toEqual([]);
    const saved = localStorage.length;
    saveComparePanes(null, [host("a")]);
    expect(localStorage.length).toBe(saved);
  });

  it("migrates a v1 host list with the same ids and removes it on the first save", () => {
    localStorage.setItem(V1_KEY_P1, JSON.stringify(["a", " b ", "a", 7]));
    expect(loadComparePanes(PROJECT)).toEqual([host("a"), host("b")]);
    saveComparePanes(PROJECT, loadComparePanes(PROJECT));
    expect(localStorage.getItem(V1_KEY_P1)).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY_P1)!)).toEqual({
      version: 2,
      panes: [host("a"), host("b")],
    });
  });

  it("saves an empty lineup, so an old v1 list never comes back", () => {
    localStorage.setItem(V1_KEY_P1, JSON.stringify(["a", "b"]));
    saveComparePanes(PROJECT, []);
    expect(loadComparePanes(PROJECT)).toEqual([]);
  });

  it("reads malformed or unknown records as no panes", () => {
    localStorage.setItem(KEY_P1, "{not json");
    expect(loadComparePanes(PROJECT)).toEqual([]);
    localStorage.setItem(
      KEY_P1,
      JSON.stringify({ version: 3, panes: [host("a")] }),
    );
    expect(loadComparePanes(PROJECT)).toEqual([]);
    localStorage.removeItem(KEY_P1);
    localStorage.setItem(V1_KEY_P1, JSON.stringify("abc"));
    expect(loadComparePanes(PROJECT)).toEqual([]);
  });
});

describe("the lead pane", () => {
  it("reads an empty lineup as the lead alone", () => {
    expect(syncLeadPane([], "a")).toEqual([host("a")]);
    const empty: ComparePane[] = [];
    expect(syncLeadPane(empty, null)).toBe(empty);
  });

  it("returns the same lineup when pane 0 already runs the lead", () => {
    const panes = [host("a"), host("b")];
    expect(syncLeadPane(panes, "a")).toBe(panes);
    expect(syncLeadPane(panes, null)).toBe(panes);
  });

  it("moves the lead's pane to the front, keeping every pane and the count", () => {
    expect(syncLeadPane([host("a"), host("b"), host("c")], "c")).toEqual([
      host("c"),
      host("a"),
      host("b"),
    ]);
  });

  it("replaces pane 0 when no pane runs the lead, never growing the lineup", () => {
    expect(syncLeadPane([host("a"), host("b")], "c")).toEqual([
      host("c"),
      host("b"),
    ]);
  });
});

describe("promoteLeadPane", () => {
  it("seeds an empty lineup with the lead", () => {
    promoteLeadPane(PROJECT, "a");
    expect(loadHosts(PROJECT)).toEqual(["a"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("a");
  });

  it("rotates or replaces pane 0 and keeps the count", () => {
    saveHosts(PROJECT, ["a", "b", "c"]);
    promoteLeadPane(PROJECT, "c");
    expect(loadHosts(PROJECT)).toEqual(["c", "a", "b"]);
    promoteLeadPane(PROJECT, "z");
    expect(loadHosts(PROJECT)).toEqual(["z", "a", "b"]);
    expect(loadPreviewedHostId(PROJECT)).toBe("z");
  });

  it("clears only the lead for a null or blank client", () => {
    saveHosts(PROJECT, ["a", "b"]);
    savePreviewedHostId(PROJECT, "a");
    promoteLeadPane(PROJECT, "  ");
    expect(loadPreviewedHostId(PROJECT)).toBeNull();
    expect(loadHosts(PROJECT)).toEqual(["a", "b"]);
  });

  it("writes only the given project's lineup", () => {
    saveHosts(PROJECT_B, ["other"]);
    promoteLeadPane(PROJECT, "a");
    expect(loadHosts(PROJECT_B)).toEqual(["other"]);
  });
});

describe("subscribeComparePanes", () => {
  it("does not fire for an in-app save", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeComparePanes(callback);
    saveHosts(PROJECT, ["a", "b"]);
    expect(callback).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("fires once on a promotion, after both the lead and the panes are saved", () => {
    saveHosts(PROJECT, ["a", "b"]);
    savePreviewedHostId(PROJECT, "a");
    let seen: { lead: string | null; hosts: string[] } | undefined;
    const callback = vi.fn(() => {
      seen = { lead: loadPreviewedHostId(PROJECT), hosts: loadHosts(PROJECT) };
    });
    const unsubscribe = subscribeComparePanes(callback);
    promoteLeadPane(PROJECT, "c");
    expect(callback).toHaveBeenCalledTimes(1);
    expect(seen).toEqual({ lead: "c", hosts: ["c", "b"] });
    unsubscribe();
  });

  it("does not fire when the lead already leads", () => {
    saveHosts(PROJECT, ["a", "b"]);
    const callback = vi.fn();
    const unsubscribe = subscribeComparePanes(callback);
    promoteLeadPane(PROJECT, "a");
    expect(callback).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("fires for another tab's write to any project's panes and nothing else", () => {
    const callback = vi.fn();
    const unsubscribe = subscribeComparePanes(callback);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY_P1 }));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY_P2 }));
    window.dispatchEvent(
      new StorageEvent("storage", { key: "some-other-key" }),
    );
    expect(callback).toHaveBeenCalledTimes(2);
    unsubscribe();
    promoteLeadPane(PROJECT, "b");
    expect(callback).toHaveBeenCalledTimes(2);
  });
});

describe("pane order and the client chips", () => {
  it("moves a pane one place and leaves the ends alone", () => {
    const panes = [host("a"), host("b"), host("c")];
    expect(movePane(panes, "b", -1)).toEqual([host("b"), host("a"), host("c")]);
    expect(movePane(panes, "b", 1)).toEqual([host("a"), host("c"), host("b")]);
    expect(movePane(panes, "a", -1)).toBe(panes);
    expect(movePane(panes, "c", 1)).toBe(panes);
    expect(movePane(panes, "missing", 1)).toBe(panes);
  });

  it("lets the chips check three clients, less panes they cannot show", () => {
    expect(chipClientLimit([])).toBe(3);
    expect(chipClientLimit([host("a"), host("b")])).toBe(3);
    // A second pane on client a, and an environment pane, take a slot each.
    expect(chipClientLimit([host("a"), host("a", "a~2")])).toBe(2);
    expect(
      chipClientLimit([
        { paneId: "e", target: { kind: "environment", environmentId: "e" } },
        host("a"),
      ]),
    ).toBe(2);
  });
});
