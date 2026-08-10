import { describe, expect, it } from "vitest";
import { evalSuitePinsSandboxImage } from "../helpers";

/**
 * The pin can come from TWO places — the suite's own field (migration-era
 * override) or an ATTACHED project environment. Missing the second source is
 * exactly how env-backed suites would slip past the cloud preflight.
 */
describe("evalSuitePinsSandboxImage", () => {
  const env = { environmentId: "env-1", computerEnvironmentId: "img-1" };
  const bareEnv = { environmentId: "env-2" };

  it("detects the suite-level pin", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [], computerEnvironmentId: "img-9" } },
        undefined,
      ),
    ).toBe(true);
  });

  it("detects a pin on an attached environment", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-1"] },
        [env],
      ),
    ).toBe(true);
  });

  it("ignores attached environments without a pin", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-2"] },
        [bareEnv],
      ),
    ).toBe(false);
  });

  it("ignores pinned environments that are NOT attached to this suite", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-2"] },
        [env, bareEnv],
      ),
    ).toBe(false);
  });

  it("is false with no pins anywhere — including undefined env rows", () => {
    expect(
      evalSuitePinsSandboxImage(
        { environment: { servers: [] }, environmentIds: ["env-1"] },
        undefined,
      ),
    ).toBe(false);
    expect(evalSuitePinsSandboxImage({ environment: { servers: [] } }, [])).toBe(
      false,
    );
  });
});
