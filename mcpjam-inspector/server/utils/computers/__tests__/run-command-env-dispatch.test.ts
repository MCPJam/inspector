/**
 * Where `e2bRunner` announces that a materialized secret reached the box.
 *
 * The caller's delivery stamp hangs off this signal, and `lastDeliveredAt` is
 * what someone reads before deciding a credential was never exposed and needs
 * no rotation. So the boundary has to sit exactly at the call that carries
 * `envs`: everything before it delivered nothing, and everything after it —
 * including a timeout, whose process may still be alive in the box holding the
 * values — delivered them.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const runMock = vi.fn();
const makeDirMock = vi.fn();
const connectMock = vi.fn(async () => ({
  commands: { run: runMock },
  files: { makeDir: makeDirMock },
}));

vi.mock("e2b", () => ({
  Sandbox: { connect: (...args: unknown[]) => connectMock(...(args as [])) },
  CommandExitError: class CommandExitError extends Error {
    exitCode = 2;
    stdout = "";
    stderr = "";
  },
  TimeoutError: class TimeoutError extends Error {},
}));

import { e2bRunner } from "../run-command";

const envs = { STRIPE_API_KEY: "sk_live_abcdefgh" };
const call = (onEnvsDispatched: () => void, withEnvs = true) =>
  e2bRunner({
    sandboxId: "sbx",
    command: "stripe balance retrieve",
    timeoutMs: 1000,
    ...(withEnvs ? { envs } : {}),
    onEnvsDispatched,
  });

beforeEach(() => {
  vi.clearAllMocks();
  connectMock.mockImplementation(async () => ({
    commands: { run: runMock },
    files: { makeDir: makeDirMock },
  }));
  runMock.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
});

describe("e2bRunner env dispatch boundary", () => {
  it("announces dispatch when the command carrying envs is issued", async () => {
    const onEnvsDispatched = vi.fn();
    await call(onEnvsDispatched);
    expect(onEnvsDispatched).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      "stripe balance retrieve",
      expect.objectContaining({ envs }),
    );
  });

  it("announces dispatch even though the command then times out", async () => {
    const onEnvsDispatched = vi.fn();
    runMock.mockRejectedValue(new Error("timed out"));
    await expect(call(onEnvsDispatched)).rejects.toThrow();
    expect(onEnvsDispatched).toHaveBeenCalledTimes(1);
  });

  it("stays silent when connecting to the box fails", async () => {
    const onEnvsDispatched = vi.fn();
    connectMock.mockRejectedValue(new Error("no such sandbox") as never);
    await expect(call(onEnvsDispatched)).rejects.toThrow();
    expect(onEnvsDispatched).not.toHaveBeenCalled();
  });

  it("stays silent when there are no envs to dispatch", async () => {
    const onEnvsDispatched = vi.fn();
    await call(onEnvsDispatched, false);
    expect(onEnvsDispatched).not.toHaveBeenCalled();
  });
});
