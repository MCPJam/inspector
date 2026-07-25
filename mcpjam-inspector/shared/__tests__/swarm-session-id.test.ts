import { describe, expect, it } from "vitest";
import { swarmAttemptChatSessionId } from "../swarm-session-id";

describe("swarmAttemptChatSessionId (shared mint — D1)", () => {
  it("legacy host target: byte-identical to the historical inline mint", () => {
    // The pre-environments spelling was `synth_${runId}_${hostId}_${sessionIdx}`.
    expect(
      swarmAttemptChatSessionId("run-1", { hostId: "host-1" }, 0),
    ).toBe("synth_run-1_host-1_0");
    expect(
      swarmAttemptChatSessionId("run-1", { hostId: "host-1" }, 3),
    ).toBe("synth_run-1_host-1_3");
    // Explicit null/undefined environmentId is still legacy.
    expect(
      swarmAttemptChatSessionId(
        "run-1",
        { hostId: "host-1", environmentId: null },
        1,
      ),
    ).toBe("synth_run-1_host-1_1");
  });

  it("environment target: keys on environmentId with the env_ marker", () => {
    expect(
      swarmAttemptChatSessionId(
        "run-1",
        { hostId: "host-1", environmentId: "envA" },
        0,
      ),
    ).toBe("synth_run-1_env_envA_0");
  });

  it("two environments on the SAME host mint distinct ids", () => {
    const a = swarmAttemptChatSessionId(
      "run-1",
      { hostId: "host-1", environmentId: "envA" },
      0,
    );
    const b = swarmAttemptChatSessionId(
      "run-1",
      { hostId: "host-1", environmentId: "envB" },
      0,
    );
    expect(a).not.toBe(b);
  });
});
