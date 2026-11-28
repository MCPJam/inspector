import { beforeEach, describe, expect, it, vi } from "vitest";

const postServiceRoute = vi.fn();
vi.mock("../service-route.js", () => ({
  GITHUB_CHECKS_SERVICE_BASE: "/internal/v1/github-checks",
  postServiceRoute: (...args: unknown[]) => postServiceRoute(...args),
}));

import {
  TemporaryServerRefusedError,
  createTemporaryServer,
  deleteTemporaryServer,
} from "../temporary-server";

const LEASE = {
  triggerId: "trig-1",
  claimedBy: "inspector-gh-1",
  leaseToken: "lease-1",
};

beforeEach(() => {
  postServiceRoute.mockReset();
});

describe("createTemporaryServer", () => {
  it("posts the lease, the sandbox address and the authorization flag, and returns the backend's server", async () => {
    postServiceRoute.mockResolvedValue({
      status: 200,
      body: { ok: true, serverId: "server-1", serverName: "gh-check-trig-1" },
    });

    const created = await createTemporaryServer({
      ...LEASE,
      url: "https://3001-sb.e2b.app/mcp",
      authorizationRequired: true,
    });

    expect(created).toEqual({
      serverId: "server-1",
      serverName: "gh-check-trig-1",
    });
    expect(postServiceRoute).toHaveBeenCalledWith(
      "/internal/v1/github-checks/temporary-server",
      {
        ...LEASE,
        url: "https://3001-sb.e2b.app/mcp",
        authorizationRequired: true,
      },
    );
  });

  it.each([
    [409, { ok: false, error: "lease_lost" }, "lease_lost"],
    [403, { ok: false, error: "owner_not_member" }, "owner_not_member"],
    [200, { ok: true }, "unknown"],
    [500, null, "unknown"],
  ])("throws the refusal for a %s answer", async (status, body, reason) => {
    postServiceRoute.mockResolvedValue({ status, body });
    const call = createTemporaryServer({
      ...LEASE,
      url: "https://3001-sb.e2b.app/mcp",
      authorizationRequired: false,
    });
    await expect(call).rejects.toBeInstanceOf(TemporaryServerRefusedError);
    await expect(call).rejects.toMatchObject({ status, reason });
  });
});

describe("deleteTemporaryServer", () => {
  it("posts only the lease and reports whether a server was removed", async () => {
    postServiceRoute.mockResolvedValue({
      status: 200,
      body: { ok: true, deleted: false },
    });

    expect(await deleteTemporaryServer(LEASE)).toEqual({ deleted: false });
    expect(postServiceRoute).toHaveBeenCalledWith(
      "/internal/v1/github-checks/temporary-server/delete",
      LEASE,
    );
  });

  it("throws the refusal when the backend says no", async () => {
    postServiceRoute.mockResolvedValue({
      status: 409,
      body: { ok: false, error: "lease_lost" },
    });
    await expect(deleteTemporaryServer(LEASE)).rejects.toMatchObject({
      status: 409,
      reason: "lease_lost",
    });
  });
});
