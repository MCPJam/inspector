import { afterEach, expect, it, vi } from "vitest";

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:util", () => ({ promisify: () => exec }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.resetModules();
  exec.mockReset();
});

it("fails Windows qualification when an independent OS observer fails", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const observations = await import("../conformance/process-observations.js");
  exec.mockRejectedValue(new Error("observer unavailable"));
  await expect(observations.running(42)).rejects.toThrow(
    "observer unavailable",
  );
  await expect(observations.listeners(42)).rejects.toThrow(
    "observer unavailable",
  );
  await expect(observations.descendants(42)).rejects.toThrow(
    "observer unavailable",
  );
  expect(exec.mock.calls.at(-1)?.[1].at(-1)).toContain(
    "$ErrorActionPreference = 'Stop'",
  );
});

it("accepts a successful Windows observation with no matching process or listener", async () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const observations = await import("../conformance/process-observations.js");
  exec.mockResolvedValue({
    stdout: "INFO: No tasks are running which match the specified criteria.",
  });
  expect(await observations.running(42)).toBe(false);
  exec.mockResolvedValue({ stdout: "" });
  expect(await observations.listeners(42)).toEqual([]);
  expect(await observations.descendants(42)).toEqual([]);
});
