// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RetiredSandboxPorts } from "../sandbox-retired-ports.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "mcpjam-view-ports-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("durable App origin retirement", () => {
  it("serializes competing allocators and rejects a retired port after restart", async () => {
    const first = new RetiredSandboxPorts(() => directory);
    const second = new RetiredSandboxPorts(() => directory);
    const reservations = await Promise.all([
      first.reserve(53123),
      second.reserve(53123),
    ]);
    expect(reservations.sort()).toEqual([false, true]);
    const restarted = new RetiredSandboxPorts(() => directory);
    expect(await restarted.reserve(53123)).toBe(false);
    expect(await restarted.reserve(53124)).toBe(true);
    expect(
      JSON.parse(
        await readFile(join(directory, "sandbox-view-ports.json"), "utf8"),
      ).ports,
    ).toEqual([53123, 53124]);
  });

  it("fails closed without overwriting corrupt state", async () => {
    const file = join(directory, "sandbox-view-ports.json");
    await writeFile(file, "invalid");
    await expect(
      new RetiredSandboxPorts(() => directory).reserve(53123),
    ).rejects.toThrow("could not be verified");
    expect(await readFile(file, "utf8")).toBe("invalid");
  });
});
