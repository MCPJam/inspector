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

  it("quitting with no tab on that project leaves the entry saved", () => {
    const { registry } = setup();
    registry.poll("acme", tab(ACME, 10));
    registry.attach(request());
    registry.poll("acme", tab(ACME, 10));
    registry.claim("a1", "acme");
    registry.result("a1", { tabId: "acme", outcome: "connected", decision: decision() });
    registry.poll("acme", tab(BILLING, 11));

    registry.release("a1");
    expect(registry.poll("acme", tab(BILLING, 11)).tasks).toHaveLength(0);
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
});
