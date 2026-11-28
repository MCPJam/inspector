import { describe, expect, it } from "vitest";
import type {
  LauncherAttachRequest,
  LauncherDecision,
  LauncherTabPoll,
} from "../../../../shared/launcher-attach.js";
import {
  CLAIM_TIMEOUT_MS,
  LauncherAttachRegistry,
  MAX_ATTACH_REQUESTS,
  TAB_TTL_MS,
} from "../registry.js";

const ACME = { id: "proj-acme", name: "Acme Tools" };
const BILLING = { id: "proj-billing", name: "Billing" };

function setup(options: { alive?: Set<number> } = {}) {
  let now = 1_000_000;
  const alive = options.alive ?? new Set<number>();
  const registry = new LauncherAttachRegistry({
    now: () => now,
    isPidAlive: (pid) => alive.has(pid),
  });
  return {
    registry,
    alive,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function request(overrides: Partial<LauncherAttachRequest> = {}): LauncherAttachRequest {
  return {
    attachId: "a1",
    server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
    ...overrides,
  };
}

function tab(
  project: LauncherTabPoll["project"],
  focusedAt: number,
  signedIn = true,
): LauncherTabPoll {
  return { focusedAt, signedIn, project };
}

function decision(overrides: Partial<LauncherDecision> = {}): LauncherDecision {
  return {
    projectId: ACME.id,
    projectName: ACME.name,
    serverName: "billing-mcp",
    createdByAttach: true,
    ...overrides,
  };
}

describe("LauncherAttachRegistry", () => {
  it("hands a request to the most recently focused signed-in tab only", () => {
    const { registry } = setup();
    registry.poll("old", tab(ACME, 10));
    registry.poll("new", tab(ACME, 20));
    registry.attach(request());

    const toNew = registry.poll("new", tab(ACME, 20));
    const toOld = registry.poll("old", tab(ACME, 10));

    expect(toNew.tasks).toHaveLength(1);
    expect(toNew.tasks[0]).toMatchObject({
      kind: "attach",
      attachId: "a1",
      openProjects: [ACME],
    });
    expect(toOld.tasks).toHaveLength(0);
  });

  it("lists every project shown by signed-in tabs so the tab can ask", () => {
    const { registry } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(BILLING, 20));
    registry.poll("guest", tab(null, 30, false));
    registry.attach(request());

    const response = registry.poll("t2", tab(BILLING, 20));
    expect(response.tasks[0]).toMatchObject({ openProjects: [ACME, BILLING] });
  });

  it("only the assigned tab can claim, and a claim cannot be taken twice", () => {
    const { registry } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(ACME, 20));
    registry.attach(request());
    registry.poll("t2", tab(ACME, 20));

    expect(registry.claim("a1", "t1")).toBe("not_assigned");
    expect(registry.claim("a1", "t2")).toBeUndefined();
    expect(registry.claim("a1", "t2")).toBe("not_assigned");
    expect(registry.state("a1")?.status).toBe("claimed");
    expect(registry.poll("t2", tab(ACME, 20)).tasks).toHaveLength(0);
  });

  it("reassigns when the assigned tab never claims", () => {
    const { registry, advance } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(ACME, 20));
    registry.attach(request());
    expect(registry.poll("t2", tab(ACME, 20)).tasks).toHaveLength(1);

    advance(CLAIM_TIMEOUT_MS + 1);
    registry.poll("t2", tab(ACME, 20));
    const toT1 = registry.poll("t1", tab(ACME, 10));

    expect(toT1.tasks).toHaveLength(1);
    expect(registry.claim("a1", "t1")).toBeUndefined();
  });

  it("reassigns when the tab that claimed closes before finishing", () => {
    const { registry, advance } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(ACME, 20));
    registry.attach(request());
    registry.poll("t2", tab(ACME, 20));
    registry.claim("a1", "t2");

    advance(TAB_TTL_MS + 1);
    const toT1 = registry.poll("t1", tab(ACME, 10));

    expect(toT1.tasks).toHaveLength(1);
    expect(registry.state("a1")?.status).toBe("pending");
  });

  it("reassigns at once when a tab says it closed", () => {
    const { registry } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(ACME, 20));
    registry.attach(request());
    registry.poll("t2", tab(ACME, 20));

    registry.closeTab("t2");
    expect(registry.poll("t1", tab(ACME, 10)).tasks).toHaveLength(1);
  });

  it("two tabs racing for one request: exactly one wins", () => {
    const { registry, advance } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(ACME, 20));
    registry.attach(request());
    registry.poll("t2", tab(ACME, 20));
    advance(CLAIM_TIMEOUT_MS + 1);
    // t1 now holds the assignment; t2's late claim loses.
    registry.poll("t1", tab(ACME, 10));
    const late = registry.claim("a1", "t2");
    const winner = registry.claim("a1", "t1");

    expect([late, winner]).toEqual(["not_assigned", undefined]);
  });

  it("waits for sign-in and tells signed-out tabs what is waiting", () => {
    const { registry } = setup();
    registry.attach(request());
    const guest = registry.poll("guest", tab(null, 10, false));

    expect(guest.tasks).toHaveLength(0);
    expect(guest.waitingForSignIn).toEqual([
      { attachId: "a1", serverName: "billing-mcp" },
    ]);

    const signedIn = registry.poll("guest", tab(ACME, 11, true));
    expect(signedIn.tasks).toHaveLength(1);
    expect(signedIn.waitingForSignIn).toEqual([]);
  });

  it("a signed-out tab never takes a request while a signed-in tab is open", () => {
    const { registry } = setup();
    registry.poll("me", tab(ACME, 10));
    registry.attach(request());
    const guest = registry.poll("guest", tab(null, 99, false));

    expect(guest.tasks).toHaveLength(0);
    expect(guest.waitingForSignIn).toEqual([]);
  });

  it("routes a request to the tab showing the project the developer picked", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));
    registry.attach(request());
    registry.poll("billing", tab(BILLING, 20));
    registry.claim("a1", "billing");

    expect(registry.route("a1", "billing", ACME.id)).toBeUndefined();
    expect(registry.poll("billing", tab(BILLING, 20)).tasks).toHaveLength(0);
    const toAcme = registry.poll("acme", tab(ACME, 10));
    expect(toAcme.tasks[0]).toMatchObject({ targetProjectId: ACME.id });
  });

  it("asks again elsewhere when the picked project's tab closes", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));
    registry.attach(request());
    registry.poll("billing", tab(BILLING, 20));
    registry.claim("a1", "billing");
    registry.route("a1", "billing", ACME.id);
    registry.closeTab("acme");

    const task = registry.poll("billing", tab(BILLING, 20)).tasks[0];
    expect(task).toMatchObject({ kind: "attach" });
    expect(task).not.toHaveProperty("targetProjectId");
  });

  it("a restart reuses the decision and prefers the tab showing that project", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));
    registry.attach(request());
    registry.poll("billing", tab(BILLING, 20));
    registry.claim("a1", "billing");
    registry.route("a1", "billing", ACME.id);
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });
    expect(registry.state("a1")).toMatchObject({
      status: "connected",
      projectName: ACME.name,
    });

    registry.attach(request());
    expect(registry.poll("billing", tab(BILLING, 20)).tasks).toHaveLength(0);
    expect(registry.poll("acme", tab(ACME, 10)).tasks[0]).toMatchObject({
      decision: decision(),
    });
  });

  it("quitting hands the undo to a tab showing the project", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });

    expect(registry.release("a1")).toBe(true);
    const tasks = registry.poll("acme", tab(ACME, 10)).tasks;
    expect(tasks).toEqual([
      expect.objectContaining({ kind: "release", decision: decision() }),
    ]);
    expect(registry.released("a1", "acme")).toBeUndefined();
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toHaveLength(0);
    expect(registry.state("a1")).toBeUndefined();
  });

  it("an undo with no tab showing the project waits for one instead of being dropped", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });
    // The developer moves the only tab to another project, then quits.
    registry.poll("acme", tab(BILLING, 11));

    registry.release("a1");
    expect(registry.poll("acme", tab(BILLING, 11)).tasks).toHaveLength(0);
    expect(registry.releaseState("a1")).toEqual({ status: "pending" });

    // Back on the project: the undo that was promised is delivered.
    const tasks = registry.poll("acme", tab(ACME, 12)).tasks;
    expect(tasks).toEqual([expect.objectContaining({ kind: "release", decision: decision() })]);
    registry.released("a1", "acme");
    expect(registry.releaseState("a1")).toEqual({ status: "done" });
  });

  it("quitting before a tab saved anything cancels the tab's work", () => {
    const { registry } = setup();
    registry.poll("t", tab(ACME, 10));
    registry.attach(request());
    registry.poll("t", tab(ACME, 10));
    registry.claim("a1", "t");

    registry.release("a1");
    const response = registry.poll("t", tab(ACME, 10));
    expect(response.cancelledAttachIds).toEqual(["a1"]);
    expect(response.tasks).toHaveLength(0);
    expect(registry.poll("t", tab(ACME, 10)).cancelledAttachIds).toEqual([]);
  });

  it("a release and attach before any tab acts keeps the entry", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });

    registry.release("a1");
    registry.attach(request());
    const tasks = registry.poll("acme", tab(ACME, 10)).tasks;
    expect(tasks).toEqual([
      expect.objectContaining({ kind: "attach", decision: decision() }),
    ]);
  });

  it("releases requests whose dev command died", () => {
    const { registry, alive } = setup({ alive: new Set([4242]) });
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request({ pid: 4242 }));
    registry.sweep();
    expect(registry.state("a1")).toBeDefined();

    alive.delete(4242);
    registry.sweep();
    expect(registry.state("a1")).toBeUndefined();
  });

  it("only the tab that claimed can report a result", () => {
    const { registry } = setup();
    registry.poll("t", tab(ACME, 10));
    registry.attach(request());
    registry.poll("t", tab(ACME, 10));
    registry.claim("a1", "t");

    expect(
      registry.result("a1", { tabId: "other", outcome: "failed", message: "x" }),
    ).toBe("not_assigned");
    expect(
      registry.result("a1", {
        tabId: "t",
        outcome: "failed",
        message: "billing-mcp did not answer.",
      }),
    ).toBeUndefined();
    expect(registry.state("a1")).toMatchObject({
      status: "failed",
      message: "billing-mcp did not answer.",
    });
  });

  it("caps open requests", () => {
    const { registry } = setup();
    for (let i = 0; i < MAX_ATTACH_REQUESTS; i += 1) {
      expect(registry.attach(request({ attachId: `a${i}` })).ok).toBe(true);
    }
    expect(registry.attach(request({ attachId: "one-more" }))).toEqual({
      ok: false,
      error: "too_many_requests",
    });
    // The same id again is an update, not a new request.
    expect(registry.attach(request({ attachId: "a0" })).ok).toBe(true);
  });

  it("reports a release as pending until a tab acknowledges it", () => {
    const { registry } = setup();
    expect(registry.releaseState("a1")).toEqual({ status: "done" });
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });

    registry.release("a1");
    expect(registry.releaseState("a1")).toEqual({ status: "pending" });
    registry.poll("acme", tab(ACME, 10));
    expect(registry.releaseState("a1")).toEqual({ status: "pending" });
    registry.released("a1", "acme");
    expect(registry.releaseState("a1")).toEqual({ status: "done" });
  });

  it("a saved checkpoint credits the attach before the tab finishes connecting", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");

    expect(registry.result("a1", { tabId: "acme", outcome: "saved", decision: decision() })).toBeUndefined();
    expect(registry.state("a1")).toMatchObject({ status: "claimed", projectName: ACME.name });

    // Quitting while the tab still connects undoes the entry it saved.
    registry.release("a1");
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toEqual([
      expect.objectContaining({ kind: "release", decision: decision() }),
    ]);
  });

  it("quitting mid-save undoes what the tab reports having saved", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");

    // The dev command quits before the tab has reported anything.
    registry.release("a1");
    expect(registry.releaseState("a1")).toEqual({ status: "pending" });
    expect(registry.poll("acme", tab(ACME, 10)).cancelledAttachIds).toEqual(["a1"]);

    // The tab was already saving: its report is not lost.
    expect(registry.result("a1", { tabId: "acme", outcome: "saved", decision: decision() })).toBeUndefined();
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toEqual([
      expect.objectContaining({ kind: "release", decision: decision() }),
    ]);

    // The final report does not queue a second undo.
    expect(registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() })).toBeUndefined();
    registry.released("a1", "acme");
    expect(registry.releaseState("a1")).toEqual({ status: "done" });
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toHaveLength(0);
  });

  it("quitting mid-save with nothing saved leaves nothing to undo once the tab says so", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.release("a1");

    expect(registry.result("a1", { tabId: "acme", outcome: "failed", message: "no" })).toBeUndefined();
    expect(registry.releaseState("a1")).toEqual({ status: "done" });
    expect(registry.result("a1", { tabId: "other", outcome: "failed", message: "no" })).toBe("unknown_attach");
  });

  it("a claim reset by a slow tab withdraws the request from that tab", () => {
    const { registry, advance } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(ACME, 20));
    registry.attach(request());
    registry.poll("t2", tab(ACME, 20));
    registry.claim("a1", "t2");

    // t2 sleeps; t1 takes the request over.
    advance(TAB_TTL_MS + 1);
    expect(registry.poll("t1", tab(ACME, 10)).tasks).toHaveLength(1);
    // t2 wakes up: it must drop the request it was working on.
    expect(registry.poll("t2", tab(ACME, 20)).cancelledAttachIds).toEqual(["a1"]);
  });

  it("undoes what a tab saved after its claim was reset, in another project", () => {
    const { registry, advance } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));
    registry.attach(request());
    registry.poll("billing", tab(BILLING, 20));
    registry.claim("a1", "billing");

    advance(TAB_TTL_MS + 1);
    registry.poll("acme", tab(ACME, 10));
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });

    // billing wakes and reports a save into its own project.
    const stale = decision({ projectId: BILLING.id, projectName: BILLING.name });
    registry.poll("billing", tab(BILLING, 20));
    expect(registry.result("a1", { tabId: "billing", outcome: "connected", decision: stale })).toBeUndefined();
    expect(registry.poll("billing", tab(BILLING, 20)).tasks).toEqual([
      expect.objectContaining({ kind: "release", decision: stale }),
    ]);
    // The live attach keeps its own decision.
    expect(registry.state("a1")).toMatchObject({ projectName: ACME.name });
  });

  it("credits the attach with an entry a stale claimant created in the same project", () => {
    const { registry, advance } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "saved", decision: decision() });

    // A reload loses the claim; the same tab claims again and finds its own
    // entry already saved, so it reports the entry as pre-existing.
    advance(TAB_TTL_MS + 1);
    registry.poll("acme", tab(ACME, 10));
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", {
      tabId: "acme",
      outcome: "connected",
      decision: decision({ createdByAttach: false }),
    });

    // Quitting still removes it: the entry was created by this attach.
    registry.release("a1");
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toEqual([
      expect.objectContaining({ kind: "release", decision: decision({ createdByAttach: true }) }),
    ]);
  });

  it("does not hand a release to a second tab while the first is alive but busy", () => {
    const { registry, advance } = setup();
    registry.poll("t1", tab(ACME, 10));
    registry.poll("t2", tab(ACME, 20));
    registry.attach(request());
    registry.poll("t2", tab(ACME, 20));
    registry.claim("a1", "t2");
    registry.result("a1", { tabId: "t2", outcome: "connected", decision: decision() });
    registry.release("a1");

    expect(registry.poll("t2", tab(ACME, 20)).tasks).toHaveLength(1);
    // t2 is busy with a dialog for longer than the claim timeout.
    advance(CLAIM_TIMEOUT_MS + 1);
    registry.poll("t2", tab(ACME, 20));
    expect(registry.poll("t1", tab(ACME, 10)).tasks).toHaveLength(0);

    // Only when it is gone does the other tab take it.
    advance(TAB_TTL_MS + 1);
    expect(registry.poll("t1", tab(ACME, 10)).tasks).toEqual([
      expect.objectContaining({ kind: "release" }),
    ]);
  });

  it("keeps a routed request on the tabs showing the chosen project instead of bouncing", () => {
    const { registry, advance } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));
    registry.attach(request());
    registry.poll("billing", tab(BILLING, 20));
    registry.claim("a1", "billing");
    registry.route("a1", "billing", ACME.id);

    // The Acme tab is busy and does not claim within the timeout.
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toHaveLength(1);
    advance(CLAIM_TIMEOUT_MS + 1);
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));

    // The request stays with Acme's tab; the Billing tab is not asked again.
    expect(registry.poll("billing", tab(BILLING, 20)).tasks).toHaveLength(0);
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toHaveLength(1);
    expect(registry.claim("a1", "acme")).toBeUndefined();
  });

  it("keeps a release for each project an attach left an entry in", () => {
    const { registry, advance } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));
    registry.attach(request());
    registry.poll("billing", tab(BILLING, 20));
    registry.claim("a1", "billing");
    advance(TAB_TTL_MS + 1);
    registry.poll("acme", tab(ACME, 10));
    registry.poll("billing", tab(BILLING, 20));
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });
    const stale = decision({ projectId: BILLING.id, projectName: BILLING.name });
    registry.result("a1", { tabId: "billing", outcome: "connected", decision: stale });

    registry.release("a1");
    const acme = registry.poll("acme", tab(ACME, 10)).tasks;
    const billing = registry.poll("billing", tab(BILLING, 20)).tasks;
    expect(acme).toEqual([expect.objectContaining({ kind: "release", decision: decision() })]);
    expect(billing).toEqual([expect.objectContaining({ kind: "release", decision: stale })]);

    registry.released("a1", "acme");
    expect(registry.releaseState("a1")).toEqual({ status: "pending" });
    registry.released("a1", "billing");
    expect(registry.releaseState("a1")).toEqual({ status: "done" });
  });

  it("caps undelivered releases, dropping the oldest", () => {
    const { registry } = setup();
    registry.poll("acme", tab(BILLING, 10));
    for (let i = 0; i < MAX_ATTACH_REQUESTS + 5; i += 1) {
      const attachId = `r${i}`;
      registry.attach(request({ attachId }));
      registry.poll("acme", tab(BILLING, 10));
      registry.claim(attachId, "acme");
      registry.result(attachId, { tabId: "acme", outcome: "saved", decision: decision() });
      registry.release(attachId);
    }
    expect(registry.releaseState("r0")).toEqual({ status: "done" });
    expect(registry.releaseState(`r${MAX_ATTACH_REQUESTS + 4}`)).toEqual({ status: "pending" });
  });

  it("asking again while a tab is still connecting keeps that request, and its save", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "saved", decision: decision() });

    // A Vite restart sends the same attach while the tab is still connecting.
    expect(registry.attach(request()).ok).toBe(true);
    expect(registry.state("a1")).toMatchObject({ status: "claimed", projectName: ACME.name });
    expect(registry.poll("acme", tab(ACME, 10)).cancelledAttachIds).toEqual([]);

    // The tab's final report is still its own, not a stale one.
    expect(
      registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() }),
    ).toBeUndefined();
    expect(registry.state("a1")).toMatchObject({ status: "connected" });
    registry.release("a1");
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toEqual([
      expect.objectContaining({ kind: "release", decision: decision() }),
    ]);
  });

  it("asking again after the attach finished hands it to a tab again, to reconnect", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });

    registry.attach(request());
    expect(registry.poll("acme", tab(ACME, 10)).tasks).toEqual([
      expect.objectContaining({ kind: "attach", decision: decision() }),
    ]);
  });
});
