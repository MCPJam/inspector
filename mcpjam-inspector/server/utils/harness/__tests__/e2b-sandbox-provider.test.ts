import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The E2B SDK is mocked at the module boundary: these tests are about how the
// provider ADAPTS the vendor (error shapes, abort plumbing), not about E2B.
// `vi.hoisted` because `vi.mock` factories are lifted above ordinary top-level
// declarations and could not otherwise see these.
const mocks = vi.hoisted(() => {
  class FakeCommandExitError extends Error {
    constructor(
      public exitCode: number,
      public stdout: string,
      public stderr: string,
    ) {
      super("exit status " + exitCode);
      this.name = "CommandExitError";
    }
  }
  class FakeFileNotFoundError extends Error {}
  return {
    FakeCommandExitError,
    FakeFileNotFoundError,
    run: vi.fn(),
    read: vi.fn(),
    write: vi.fn(),
    connect: vi.fn(),
  };
});
const { FakeCommandExitError } = mocks;
const sandboxState = mocks;

vi.mock("e2b", () => ({
  Sandbox: {
    connect: async (id: string, opts?: Record<string, unknown>) => {
      mocks.connect(id, opts);
      return {
        sandboxId: id,
        commands: { run: mocks.run },
        files: { read: mocks.read, write: mocks.write },
        getHost: (p: number) => `host-${p}.e2b.dev`,
      };
    },
  },
  CommandExitError: mocks.FakeCommandExitError,
  FileNotFoundError: mocks.FakeFileNotFoundError,
}));

import { createE2BHarnessSandboxProvider } from "../e2b-sandbox-provider.js";

beforeEach(() => {
  sandboxState.run.mockReset();
  sandboxState.run.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  sandboxState.connect.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const provider = () => createE2BHarnessSandboxProvider({ sandboxId: "sbx_1" });

describe("the pnpm guard", () => {
  it("explains itself when pnpm is missing and installing it fails", async () => {
    // This is the failure that cost a full debugging session: E2B's raw
    // `CommandExitError` carries only "exit status 1", so a turn that died
    // because the box could not reach the package registry reported nothing
    // about the box, the exit code, or the registry.
    sandboxState.run.mockRejectedValueOnce(
      new FakeCommandExitError(1, "", "npm error code ECONNRESET"),
    );

    await expect(provider().createSession()).rejects.toThrow(
      /pnpm is missing on sandbox sbx_1.*exit 1.*ECONNRESET/s,
    );
  });

  it("names the egress lock as the likely cause", async () => {
    // The message has to point at the actual mechanism, because the fix is an
    // ordering one and nothing else in the failure hints at it.
    sandboxState.run.mockRejectedValueOnce(
      new FakeCommandExitError(1, "", "network request failed"),
    );

    await expect(provider().createSession()).rejects.toThrow(
      /egress is already locked to the model proxy/i,
    );
  });

  it("passes a non-exit failure through untouched", async () => {
    // A transport failure is not a command that ran and failed; dressing it up
    // as one would be a lie about what happened.
    sandboxState.run.mockRejectedValueOnce(new Error("socket hang up"));

    await expect(provider().createSession()).rejects.toThrow("socket hang up");
  });

  it("stays quiet on a box that already has pnpm", async () => {
    await expect(provider().createSession()).resolves.toMatchObject({
      id: "sbx_1",
    });
  });
});

describe("abort plumbing", () => {
  it("hands the caller's signal to connect and to the guard command", async () => {
    // Without this, an aborted bootstrap kept running to the ten-minute command
    // timeout while the turn was already over — the box held, the user waiting.
    const controller = new AbortController();
    await provider().createSession({ abortSignal: controller.signal });

    expect(sandboxState.connect).toHaveBeenCalledWith(
      "sbx_1",
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(sandboxState.run).toHaveBeenCalledWith(
      expect.stringContaining("pnpm"),
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  describe("the session-env delivery stamp", () => {
    // `lastDeliveredAt` is read before deleting a credential believed dormant,
    // so it has to mean "something received this", not "a turn got far enough
    // to hold it". Constructing a provider only puts the values in a local
    // object — harness setup can still throw before any command runs.
    const withEnv = (onSessionEnvUsed: () => void) =>
      createE2BHarnessSandboxProvider({
        sandboxId: "sbx_1",
        sessionEnv: { STRIPE_API_KEY: "sk_live_x" },
        onSessionEnvUsed,
      });

    it("does NOT fire on construction, only when a command carries the env", async () => {
      const stamped = vi.fn();
      const p = withEnv(stamped);
      // Constructed, and holding the values — but nothing has reached the box.
      expect(stamped).not.toHaveBeenCalled();

      const session = await p.createSession();
      await session.run({ command: "stripe customers list" });
      expect(stamped).toHaveBeenCalledTimes(1);
    });

    it("fires ONCE across several commands", async () => {
      const stamped = vi.fn();
      const session = await withEnv(stamped).createSession();
      await session.run({ command: "one" });
      await session.run({ command: "two" });
      await session.run({ command: "three" });
      expect(stamped).toHaveBeenCalledTimes(1);
    });

    it("actually merges the env into the command it stamps for", async () => {
      // The stamp must not be able to drift away from the delivery: if this
      // assertion and the one above ever disagree, the callback is lying.
      const stamped = vi.fn();
      const session = await withEnv(stamped).createSession();
      sandboxState.run.mockClear();
      await session.run({ command: "echo hi" });
      expect(sandboxState.run).toHaveBeenCalledWith(
        "echo hi",
        expect.objectContaining({
          envs: expect.objectContaining({ STRIPE_API_KEY: "sk_live_x" }),
        }),
      );
      expect(stamped).toHaveBeenCalledTimes(1);
    });

    it("never fires when there is no session env at all", async () => {
      const stamped = vi.fn();
      const session = await createE2BHarnessSandboxProvider({
        sandboxId: "sbx_1",
        onSessionEnvUsed: stamped,
      }).createSession();
      await session.run({ command: "echo hi" });
      expect(stamped).not.toHaveBeenCalled();
    });

    it("a throwing callback does not break the command", async () => {
      // Best-effort by contract: failing to RECORD a delivery must never fail
      // the delivery, and this sits directly in the command path.
      const session = await withEnv(() => {
        throw new Error("convex down");
      }).createSession();
      await expect(session.run({ command: "echo hi" })).resolves.toBeDefined();
    });

    it("does NOT fire when E2B rejects before accepting the command", async () => {
      const stamped = vi.fn();
      const session = await withEnv(stamped).createSession();
      sandboxState.run.mockRejectedValueOnce(new Error("socket hang up"));

      await expect(session.run({ command: "echo hi" })).rejects.toThrow(
        "socket hang up",
      );
      expect(stamped).not.toHaveBeenCalled();
    });

    it("fires for a command that ran and exited non-zero", async () => {
      const stamped = vi.fn();
      const session = await withEnv(stamped).createSession();
      sandboxState.run.mockRejectedValueOnce(
        new FakeCommandExitError(2, "", "bad command"),
      );

      await expect(session.run({ command: "false" })).resolves.toMatchObject({
        exitCode: 2,
      });
      expect(stamped).toHaveBeenCalledTimes(1);
    });
  });

  it("honors a per-command signal on exec", async () => {
    const session = await provider().createSession();
    const controller = new AbortController();
    sandboxState.run.mockClear();

    await session.run({ command: "echo hi", abortSignal: controller.signal });

    expect(sandboxState.run).toHaveBeenCalledWith(
      "echo hi",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("omits the signal key entirely when there is none", async () => {
    // E2B treats an explicit `signal: undefined` differently from an absent
    // key in some SDK versions; not sending it is the safe shape.
    const session = await provider().createSession();
    sandboxState.run.mockClear();

    await session.run({ command: "echo hi" });

    const opts = sandboxState.run.mock.calls[0]![1] as Record<string, unknown>;
    expect("signal" in opts).toBe(false);
  });

  it("resumeSession honors the signal too", async () => {
    const controller = new AbortController();
    await provider().resumeSession!({
      sessionId: "session-1",
      abortSignal: controller.signal,
    });

    expect(sandboxState.connect).toHaveBeenCalledWith(
      "sbx_1",
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe("exec result normalization", () => {
  it("returns a failed command as a result, not a rejection", async () => {
    // The sandbox contract wants the exit code and streams surfaced. This is
    // the behavior the pnpm guard deliberately does NOT share, so it is worth
    // pinning that they stay different.
    const session = await provider().createSession();
    sandboxState.run.mockRejectedValueOnce(
      new FakeCommandExitError(3, "out", "err"),
    );

    await expect(session.run({ command: "false" })).resolves.toEqual({
      exitCode: 3,
      stdout: "out",
      stderr: "err",
    });
  });
});
