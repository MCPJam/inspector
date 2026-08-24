import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The capabilities route (`capabilities.ts`).
 *
 * This endpoint is a permission DERIVATION, so a quiet mistake here does not
 * produce an error — it produces an agent that plans the wrong work. The two
 * failures worth guarding are opposite:
 *
 *   - claiming a capability the caller lacks, which sends an agent into a task
 *     it will fail partway through, after telling someone it was doing it;
 *   - denying one they have, which is how an agent refuses to STOP a running
 *     fan-out because the org lost a beta flag — exactly when stopping matters.
 */

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import capabilities from "../capabilities.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "proj_a";

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", capabilities);
  return app;
}

function get() {
  return makeApp().request(`/api/v1/projects/${PROJECT}/capabilities`);
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    organizationId: "org_1",
    role: "member",
    projectRole: "member",
    isProjectAdmin: false,
    features: {
      sandboxes: {
        flagEnabled: true,
        mode: "enforce",
        enforced: false,
      },
    },
    plan: { name: "free", limits: {}, features: {} },
    ...overrides,
  };
}

type Body = {
  can: Record<string, boolean>;
  features: { sandboxes: Record<string, unknown> };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.test");
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("capability derivation", () => {
  it("gives a guest nothing", async () => {
    queryMock.mockResolvedValue(row({ role: "guest", projectRole: "guest" }));
    const body = (await (await get()).json()) as Body;
    expect(body.can.readSwarms).toBe(false);
    expect(body.can.writeSwarms).toBe(false);
    expect(body.can.publishUserTestingScenario).toBe(false);
  });

  it("gives a member authoring but not publishing", async () => {
    queryMock.mockResolvedValue(row());
    const body = (await (await get()).json()) as Body;
    expect(body.can.writeSwarms).toBe(true);
    expect(body.can.launchJourneyRun).toBe(true);
    // Publishing exposes an environment to outsiders; that needs admin.
    expect(body.can.publishUserTestingScenario).toBe(false);
  });

  it("gives a member the exposure controls but not guest execution", async () => {
    // The scenario mutations behind mode changes, member edits and link
    // rotation gate at workspace MEMBERSHIP upstream — reporting them as
    // admin-only denied capabilities the caller actually held, this
    // endpoint's own failure mode. Guest execution is the one exposure
    // control that genuinely needs admin, and it is a separate key.
    queryMock.mockResolvedValue(row());
    const body = (await (await get()).json()) as Body;
    expect(body.can.changeUserTestingExposure).toBe(true);
    expect(body.can.manageUserTestingGuestExecution).toBe(false);
  });

  it("does not let a project GRANT stand in for org membership", async () => {
    // `requireProjectRole` ranks the ORG role and ignores the grant, so a
    // guest holding one cannot author. Claiming otherwise would be this
    // endpoint causing the failure it exists to prevent.
    queryMock.mockResolvedValue(
      row({ role: "guest", projectRole: "editor", isProjectAdmin: false })
    );
    const body = (await (await get()).json()) as Body;
    expect(body.can.readSwarms).toBe(false);
    expect(body.can.writeSwarms).toBe(false);
  });

  it("still grants PUBLISHING to a project-admin grant held by a guest", async () => {
    // The asymmetry is the backend's, mirrored rather than smoothed over:
    // publishing checks `canManageProjectMembers`, which an `admin` project
    // grant satisfies on its own, while reads and authoring do not.
    queryMock.mockResolvedValue(
      row({ role: "guest", projectRole: "admin", isProjectAdmin: true })
    );
    const body = (await (await get()).json()) as Body;
    expect(body.can.publishUserTestingScenario).toBe(true);
    // Guest execution follows the same `canManageProjectMembers` bar as
    // publishing, so the grant satisfies it too…
    expect(body.can.manageUserTestingGuestExecution).toBe(true);
    // …while the membership-level keys keep ranking the org role alone.
    expect(body.can.changeUserTestingExposure).toBe(false);
    expect(body.can.writeSwarms).toBe(false);
  });

  it("lets an ungated ADMIN publish and widen exposure", async () => {
    // The positive half of the admin gate. Without it, a derivation pinned to
    // `false` would pass every other case in this file.
    queryMock.mockResolvedValue(row({ role: "admin", isProjectAdmin: true }));
    const body = (await (await get()).json()) as Body;
    expect(body.can.publishUserTestingScenario).toBe(true);
    expect(body.can.unpublishUserTestingScenario).toBe(true);
    expect(body.can.changeUserTestingExposure).toBe(true);
    expect(body.can.manageUserTestingGuestExecution).toBe(true);
    expect(body.can.requestInsights).toBe(true);
  });

  it("gives the eval EDIT tier to a guest holding only a project grant", async () => {
    // The case that separates the eval keys from the swarm keys above. Swarm
    // writes rank the org role alone, so this caller cannot author a journey;
    // eval writes resolve project ACCESS, where the grant counts, so every
    // eval write in this project would be accepted. Reporting `isMember` for
    // both would deny capabilities this caller holds.
    queryMock.mockResolvedValue(
      row({ role: "guest", projectRole: "editor", isProjectAdmin: false })
    );
    const body = (await (await get()).json()) as Body;
    expect(body.can.writeSwarms).toBe(false);
    expect(body.can.readEvals).toBe(true);
    expect(body.can.writeEvalSuites).toBe(true);
    expect(body.can.launchEvalRun).toBe(true);
    expect(body.can.exportEvalTraces).toBe(true);
  });

  it("withholds deleting OTHER people's eval suites from a member", async () => {
    // The G1c tightening: destructive eval actions need the project manage
    // tier. `deleteAny*` is the honest name — the backend keeps a creator
    // escape hatch this project-level answer cannot express, which is why the
    // key does not claim to describe a suite the caller made.
    queryMock.mockResolvedValue(row());
    const body = (await (await get()).json()) as Body;
    expect(body.can.writeEvalSuites).toBe(true);
    expect(body.can.deleteAnyEvalSuite).toBe(false);
    expect(body.can.deleteAnyEvalRun).toBe(false);
  });

  it("gives deleting to an admin, and to a project-admin GRANT", async () => {
    // Both halves of `canManageProjectMembers`, which is exactly the tier the
    // backend's `manage` predicate applies to eval deletes.
    queryMock.mockResolvedValue(row({ role: "admin", isProjectAdmin: true }));
    const asAdmin = (await (await get()).json()) as Body;
    expect(asAdmin.can.deleteAnyEvalSuite).toBe(true);
    expect(asAdmin.can.deleteAnyEvalRun).toBe(true);

    queryMock.mockResolvedValue(
      row({ role: "guest", projectRole: "admin", isProjectAdmin: true })
    );
    const asGrantHolder = (await (await get()).json()) as Body;
    expect(asGrantHolder.can.deleteAnyEvalSuite).toBe(true);
    // …even though the same caller cannot author a swarm.
    expect(asGrantHolder.can.writeSwarms).toBe(false);
  });

  it("keeps the eval keys out of the beta gate", async () => {
    // Evals are not behind `sandboxes-enabled`. An org that loses the flag
    // keeps every eval capability, and an agent that inferred otherwise would
    // refuse work the platform still does.
    queryMock.mockResolvedValue(
      row({
        role: "admin",
        isProjectAdmin: true,
        features: {
          sandboxes: { flagEnabled: false, mode: "enforce", enforced: true },
        },
      })
    );
    const body = (await (await get()).json()) as Body;
    expect(body.can.writeSwarms).toBe(false);
    expect(body.can.writeEvalSuites).toBe(true);
    expect(body.can.launchEvalRun).toBe(true);
    expect(body.can.deleteAnyEvalSuite).toBe(true);
  });

  it("does not answer 200 when the safety read itself fails", async () => {
    // The degrade-to-ungated path is for a projection that is PRESENT but
    // lagging. A read that failed outright knows nothing, and answering it
    // with a permissive body would invent capabilities from an error.
    queryMock.mockRejectedValue(new Error("fetch failed"));
    expect((await get()).status).toBeGreaterThanOrEqual(500);
  });

  it("keeps the STOPPING capabilities true for a gated org", async () => {
    // The whole point of the exposure-direction rule: an org that has just
    // lost the beta must still be able to stop a run and take a scenario down.
    // An agent that inferred "no flag ⇒ nothing works" would refuse precisely
    // when it matters most.
    queryMock.mockResolvedValue(
      row({
        role: "admin",
        isProjectAdmin: true,
        features: {
          sandboxes: { flagEnabled: false, mode: "enforce", enforced: true },
        },
      })
    );
    const body = (await (await get()).json()) as Body;
    expect(body.can.cancelJourneyRun).toBe(true);
    expect(body.can.unpublishUserTestingScenario).toBe(true);
    // The scenario controls stay true too: none of the scenario mutations
    // behind them (mode, members, rotate, guest execution) check the beta
    // flag — only publish/rebind do. Claiming otherwise would deny writes
    // the backend accepts.
    expect(body.can.changeUserTestingExposure).toBe(true);
    expect(body.can.manageUserTestingGuestExecution).toBe(true);
    // …while the exposure-creating half is refused.
    expect(body.can.writeSwarms).toBe(false);
    expect(body.can.publishUserTestingScenario).toBe(false);
  });

  it("does not treat a DARK gate as a refusal", async () => {
    // In `dark` the flag is evaluated and logged but not applied, so a
    // would-be denial is not a denial. Planning around it would have an agent
    // refuse work the platform would have done.
    queryMock.mockResolvedValue(
      row({
        features: {
          sandboxes: { flagEnabled: false, mode: "dark", enforced: false },
        },
      })
    );
    const body = (await (await get()).json()) as Body;
    expect(body.features.sandboxes.enabled).toBe(false);
    expect(body.features.sandboxes.mode).toBe("dark");
    expect(body.can.writeSwarms).toBe(true);
  });

  it("degrades to ungated rather than 500ing on a lagging projection", async () => {
    // A hand-mirrored shape can fall behind the backend. This endpoint exists
    // so callers can plan safely; an opaque 500 from the safety read is the
    // worst possible failure mode for it.
    queryMock.mockResolvedValue(row({ features: undefined }));
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.features.sandboxes.enforced).toBe(false);
    expect(body.can.writeSwarms).toBe(true);
  });

  it("404s a project the caller cannot see", async () => {
    // Never 403: that would confirm the project exists.
    queryMock.mockResolvedValue(null);
    expect((await get()).status).toBe(404);
  });
});
