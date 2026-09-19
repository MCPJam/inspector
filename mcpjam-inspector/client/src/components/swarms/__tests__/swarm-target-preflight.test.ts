import { describe, expect, it, vi } from "vitest";
import {
  preflightSwarmTargets,
  SwarmTargetPreflightError,
} from "../swarm-target-preflight";

const targets = [{ environmentId: "env", hostId: "host", name: "Engineering" }];
const hosts = [{ hostId: "host", name: "MCPJam" }];

describe("swarm target preflight", () => {
  it("names a stale modelless client and retains its editor target", async () => {
    const resolve = vi.fn().mockRejectedValue({
      data: {
        code: "ENV_MODEL_REQUIRED",
        message: "Backend sentence",
        details: { hostId: "host" },
      },
    });
    await expect(
      preflightSwarmTargets({
        environmentIds: ["env"],
        targets,
        hosts,
        resolve,
      }),
    ).rejects.toMatchObject({
      code: "ENV_MODEL_REQUIRED",
      hostId: "host",
      message: expect.stringMatching(
        /^MCPJam has no model\. Pick a model in Models/,
      ),
    });
  });
  it("checks every target and stops at any launch refusal", async () => {
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({
        data: { code: "ENV_PLUGIN_UNAVAILABLE", message: "Plugin was removed" },
      });
    await expect(
      preflightSwarmTargets({
        environmentIds: ["other", "env"],
        targets,
        hosts,
        resolve,
      }),
    ).rejects.toMatchObject({
      code: "ENV_PLUGIN_UNAVAILABLE",
      message: "Engineering: Plugin was removed",
    });
    expect(resolve.mock.calls).toEqual([["other"], ["env"]]);
  });
  it("allows all runnable targets and preserves transport failures as failures", async () => {
    await expect(
      preflightSwarmTargets({
        environmentIds: ["env"],
        targets,
        hosts,
        resolve: async () => ({}),
      }),
    ).resolves.toBeUndefined();
    await expect(
      preflightSwarmTargets({
        environmentIds: ["env"],
        targets,
        hosts,
        resolve: async () => {
          throw new Error("Offline");
        },
      }),
    ).rejects.toBeInstanceOf(SwarmTargetPreflightError);
  });
});
