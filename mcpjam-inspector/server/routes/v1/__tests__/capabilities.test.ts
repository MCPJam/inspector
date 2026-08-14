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

  it("counts a PROJECT grant as membership on its own", async () => {
    // An org role this gateway does not rank should not erase a project the
    // backend already said the caller belongs to.
    queryMock.mockResolvedValue(
      row({ role: "billing_only", projectRole: "member" })
    );
    const body = (await (await get()).json()) as Body;
    expect(body.can.readSwarms).toBe(true);
    expect(body.can.writeSwarms).toBe(true);
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
