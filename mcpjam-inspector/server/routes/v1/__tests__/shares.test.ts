import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { queryMock, mutationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
}));

import shares from "../shares.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "proj_a";
const OTHER = "proj_b";
const RUN = "run_1";
const BASE = `/api/v1/projects/${PROJECT}/shares/conformanceRun/${RUN}`;

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", shares);
  return app;
}

function call(method: string, path: string, body?: unknown) {
  return makeApp().request(path, {
    method,
    ...(body !== undefined
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
}

const envelope = {
  resourceType: "conformanceRun",
  resourceId: RUN,
  projectId: PROJECT,
  mode: "anyone_with_link",
  policyVersion: 2,
  link: { token: "tok" },
  members: [],
};

describe("v1 shares", () => {
  beforeEach(() => {
    queryMock.mockReset();
    mutationMock.mockReset();
    vi.stubEnv("CONVEX_URL", "https://convex.test");
  });

  it("cross-project preflight is 404", async () => {
    queryMock.mockResolvedValueOnce({ ...envelope, projectId: OTHER });
    const res = await call("GET", BASE);
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("GET is projected, never spread", async () => {
    queryMock.mockResolvedValue(envelope);
    const res = await call("GET", BASE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      resourceType: "conformanceRun",
      resourceId: RUN,
      projectId: PROJECT,
      mode: "anyone_with_link",
      maxShareMode: null,
      policyVersion: 2,
      link: { token: "tok" },
      members: [],
    });
    expect(body).not.toHaveProperty("inviteEpoch");
  });

  it("whitelists maxShareMode from the envelope", async () => {
    queryMock.mockResolvedValue({
      ...envelope,
      maxShareMode: "invited_only",
      inviteEpoch: 9,
    });
    const res = await call("GET", BASE);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.maxShareMode).toBe("invited_only");
    expect(body).not.toHaveProperty("inviteEpoch");
  });

  it("forwards sendInviteEmail explicitly, defaulting false", async () => {
    queryMock.mockResolvedValue(envelope);
    mutationMock.mockResolvedValue(envelope);
    await call("PUT", `${BASE}/members`, { email: "a@example.com" });
    expect(mutationMock).toHaveBeenCalledWith(
      "shares:upsertShareMember",
      expect.objectContaining({
        email: "a@example.com",
        sendInviteEmail: false,
      }),
    );
  });

  it("honors sendInviteEmail: true", async () => {
    queryMock.mockResolvedValue(envelope);
    mutationMock.mockResolvedValue(envelope);
    await call("PUT", `${BASE}/members`, {
      email: "a@example.com",
      sendInviteEmail: true,
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "shares:upsertShareMember",
      expect.objectContaining({ sendInviteEmail: true }),
    );
  });
});
