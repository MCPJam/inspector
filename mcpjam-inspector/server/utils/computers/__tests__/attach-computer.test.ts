import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { attachComputerSandbox } from "../attach-computer.js";
import type { ComputerSandboxInfo } from "../control-plane-client.js";
const mocks = vi.hoisted(() => ({
  wake: vi.fn(),
  info: vi.fn(),
  attach: vi.fn(),
}));
vi.mock("../control-plane-client.js", () => ({
  wakeComputer: mocks.wake,
  getComputerSandboxInfo: mocks.info,
}));
vi.mock("../attach-sandbox.js", async (original) => ({
  ...(await original<typeof import("../attach-sandbox.js")>()),
  attachRunningSandbox: mocks.attach,
}));
const computer: ComputerSandboxInfo = {
  computerId: "computer",
  providerComputerId: "box",
  provider: "e2b",
  status: "hibernating",
  projectId: "project",
  ownerUserId: "owner",
};
beforeEach(() => {
  mocks.wake
    .mockReset()
    .mockResolvedValue({ ok: true, value: { ok: "waking" } });
  mocks.info
    .mockReset()
    .mockResolvedValue({ ok: true, value: { ...computer, status: "ready" } });
  mocks.attach.mockReset().mockResolvedValue({ sandboxId: "box" });
});
afterEach(() => vi.restoreAllMocks());
it("wakes by authorized computer row and then attaches the same box", async () => {
  expect(await attachComputerSandbox(computer)).toEqual({ sandboxId: "box" });
  expect(mocks.wake).toHaveBeenCalledWith({
    computerId: "computer",
    signal: expect.any(AbortSignal),
  });
  expect(mocks.attach).toHaveBeenCalledWith("box", {
    signal: expect.any(AbortSignal),
  });
});
it("waits for a cold computer to become ready", async () => {
  mocks.info.mockResolvedValueOnce({
    ok: true,
    value: { ...computer, status: "waking" },
  });
  await attachComputerSandbox(computer);
  expect(mocks.info).toHaveBeenCalledTimes(3);
});
it.each(["ownerUserId", "projectId", "providerComputerId"])(
  "rejects a changed %s while waking",
  async (field) => {
    mocks.info.mockResolvedValue({
      ok: true,
      value: { ...computer, status: "ready", [field]: "replacement" },
    });
    await expect(attachComputerSandbox(computer)).rejects.toThrow(
      "no longer available",
    );
    expect(mocks.attach).not.toHaveBeenCalled();
  },
);
it("propagates a refused wake without attaching", async () => {
  mocks.wake.mockResolvedValue({
    ok: false,
    status: 409,
    error: "unavailable",
  });
  await expect(attachComputerSandbox(computer)).rejects.toThrow(
    "Could not wake",
  );
  expect(mocks.attach).not.toHaveBeenCalled();
});
it("stops after a failed wake reaches the error state", async () => {
  mocks.info.mockResolvedValue({
    ok: true,
    value: { ...computer, status: "error" },
  });
  await expect(attachComputerSandbox(computer)).rejects.toThrow("unavailable");
  expect(mocks.attach).not.toHaveBeenCalled();
});
it("cancels polling when the terminal or request closes", async () => {
  const abort = new AbortController();
  mocks.info.mockImplementation(async () => {
    abort.abort();
    return { ok: true, value: { ...computer, status: "waking" } };
  });
  await expect(attachComputerSandbox(computer, abort.signal)).rejects.toThrow();
  expect(mocks.attach).not.toHaveBeenCalled();
});

it("refuses ownership changes while connection preparation waits", async () => {
  mocks.attach.mockImplementation(async () => {
    mocks.info.mockResolvedValue({
      ok: true,
      value: { ...computer, status: "ready", ownerUserId: "new-owner" },
    });
    return { sandboxId: "box" };
  });
  await expect(attachComputerSandbox(computer)).rejects.toThrow(
    "no longer available",
  );
});
