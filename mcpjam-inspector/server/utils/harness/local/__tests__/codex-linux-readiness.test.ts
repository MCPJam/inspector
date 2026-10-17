import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ access: vi.fn(), run: vi.fn() }));
vi.mock("node:fs/promises", async (load) => ({ ...await load<typeof import("node:fs/promises")>(), access: mocks.access }));
vi.mock("node:child_process", async (load) => {
  const actual = await load<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: mocks.run });
  return { ...actual, execFile };
});
import { probeCodexLinuxSandbox } from "../codex-linux-readiness.js";
beforeEach(() => { vi.resetAllMocks(); mocks.access.mockResolvedValue(undefined); });
it("probes a capable system helper using isolated user and network namespaces", async () => {
  mocks.run.mockResolvedValueOnce({ stdout: "--as-pid-1 --perms", stderr: "" }).mockResolvedValueOnce({ stdout: "", stderr: "" });
  expect(await probeCodexLinuxSandbox("/runtime", "/system")).toEqual({ ok: true });
  expect(mocks.run).toHaveBeenLastCalledWith("/system/bwrap", expect.arrayContaining(["--unshare-user", "--unshare-net", "--ro-bind", "/bin/true"]), expect.objectContaining({ timeout: 2000 }));
});
it("uses the vendor helper when the system helper lacks required options", async () => {
  mocks.run.mockResolvedValueOnce({ stdout: "old helper", stderr: "" }).mockResolvedValueOnce({ stdout: "", stderr: "" });
  expect(await probeCodexLinuxSandbox("/runtime", "/system")).toEqual({ ok: true });
  expect(mocks.run.mock.calls[1][0]).toBe("/runtime/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex/codex-resources/bwrap");
});
it("refuses denied namespaces and missing helpers", async () => {
  mocks.access.mockRejectedValue(new Error("missing"));
  mocks.run.mockRejectedValue(new Error("namespace denied"));
  expect(await probeCodexLinuxSandbox("/runtime", "/system")).toMatchObject({ ok: false });
});
