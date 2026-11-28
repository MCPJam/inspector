import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eligible: vi.fn(),
  ensure: vi.fn(),
  resolveActor: vi.fn(),
}));

vi.mock("../../../utils/harness/local/run-resources.js", () => ({
  eligibleUnattendedLocalHarnesses: mocks.eligible,
}));
vi.mock("../../../utils/harness/local/readiness.js", () => ({
  ensureLocalHarnessTarget: mocks.ensure,
}));
vi.mock("../../../utils/harness/local/acting-user.js", () => ({
  resolveLocalHarnessActor: mocks.resolveActor,
}));

import {
  localHarnessForLaunch,
  resolveLaunchLocalHarness,
} from "../launch-local-harness.js";

const actor = {
  credential: "authkit" as const,
  userId: "authkit:user_1",
  subject: "user_1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensure.mockResolvedValue({ target: {} });
  mocks.resolveActor.mockResolvedValue({ ok: true, actor });
});

describe("resolveLaunchLocalHarness", () => {
  it("resolves every eligible harness and the actor with the request's bearer", async () => {
    mocks.eligible.mockResolvedValue(["claude-code", "codex"]);

    expect(await resolveLaunchLocalHarness("session-jwt", "proj_1")).toEqual({
      eligibleHarnessIds: ["claude-code", "codex"],
      actor,
    });
    expect(mocks.eligible).toHaveBeenCalledWith("session-jwt", "proj_1");
    expect(mocks.resolveActor).toHaveBeenCalledWith({
      authorizationHeader: "Bearer session-jwt",
      contextCredential: null,
    });
  });

  it("asks for no actor when nothing can run here", async () => {
    mocks.eligible.mockResolvedValue([]);

    expect(await resolveLaunchLocalHarness("session-jwt", "proj_1")).toEqual({
      eligibleHarnessIds: [],
    });
    expect(mocks.resolveActor).not.toHaveBeenCalled();
  });
});

describe("localHarnessForLaunch", () => {
  it("narrows inputs resolved earlier to the launch's own harnesses, without asking again", async () => {
    const launch = await localHarnessForLaunch({
      bearer: "background-jwt",
      projectId: "proj_1",
      harnesses: ["claude-code", undefined, "hosted"],
      preResolved: { eligibleHarnessIds: ["claude-code", "codex"], actor },
    });

    expect(launch).toEqual({ localHarnessIds: ["claude-code"], actor });
    expect(mocks.eligible).not.toHaveBeenCalled();
    expect(mocks.resolveActor).not.toHaveBeenCalled();
    expect(mocks.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        bearer: "background-jwt",
        harnessId: "claude-code",
        trustedActor: actor,
      }),
    );
  });

  it("resolves everything itself with the request's bearer when nothing was resolved earlier", async () => {
    mocks.eligible.mockResolvedValue(["codex"]);

    const launch = await localHarnessForLaunch({
      bearer: "session-jwt",
      projectId: "proj_1",
      harnesses: ["codex"],
    });

    expect(launch).toEqual({ localHarnessIds: ["codex"], actor });
    expect(mocks.eligible).toHaveBeenCalledWith("session-jwt", "proj_1", [
      "codex",
    ]);
    expect(mocks.ensure.mock.calls[0]?.[0]).not.toHaveProperty("trustedActor");
  });
});
