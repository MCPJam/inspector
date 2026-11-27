import { describe, expect, it, vi } from "vitest";

const releaseEvalSandbox = vi.fn(async (_args: unknown) => {});

vi.mock("../../../utils/computers/control-plane-client.js", () => ({
  provisionEvalSandbox: vi.fn(async () => ({
    ok: true,
    value: { sandboxId: "sbx", sandboxRowId: "row" },
  })),
  releaseEvalSandbox: (args: unknown) => releaseEvalSandbox(args),
}));
vi.mock("../../../utils/computers/attach-sandbox.js", () => ({
  attachRunningSandbox: vi.fn(async () => ({})),
}));

import {
  PHASE_BOX_RELEASE_TIMEOUT_MS,
  withPhaseBox,
} from "../sandbox-phases/phase-box.js";

describe("the phase box release", () => {
  it("runs on its own bounded clock, even after the phase was aborted", async () => {
    const aborted = new AbortController();
    aborted.abort();
    const outcome = await withPhaseBox(
      {
        runId: "run",
        phase: "run_cleanup",
        bearer: "token",
        timeoutMs: 1000,
        signal: aborted.signal,
      },
      async () => "cleaned",
    );
    expect(outcome).toEqual({ ok: true, value: "cleaned" });
    expect(releaseEvalSandbox).toHaveBeenCalledTimes(1);
    const [{ sandboxRowId, signal }] = releaseEvalSandbox.mock.calls[0] as [
      { sandboxRowId: string; signal: AbortSignal },
    ];
    expect(sandboxRowId).toBe("row");
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal).not.toBe(aborted.signal);
    expect(signal.aborted).toBe(false);
    expect(PHASE_BOX_RELEASE_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
