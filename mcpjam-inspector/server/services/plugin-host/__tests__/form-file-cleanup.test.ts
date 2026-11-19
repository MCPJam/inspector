import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { PluginFormFileGrants } from "../form-file-grants.js";
import { createComputerFormFileStore } from "../computer-form-files.js";
import { fakeComputerFiles } from "../testing/fake-computer-files.js";
import type { PluginFormSource } from "../form-sources.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function source(instanceId = "owner"): PluginFormSource {
  return {
    owner: {
      actorId: "actor",
      projectId: "project",
      workspaceId: "workspace",
      instanceId,
      generation: 1,
      serverId: "server",
      bindingId: "binding",
      placement: "interactive",
    },
    hostId: "host",
    hostRevision: "host-revision",
    invocationId: "operation",
    origin: "app",
    revision: "revision",
    toolName: "pick",
    parent: { kind: "legacy", id: "parent", round: 0 },
    expiresAt: Date.now() + 3_600_000,
    uploadTarget: "computer",
    fileResources: true,
    requestedSchema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            options: [],
            userOptions: { kind: "file" },
          },
        },
      },
    },
  };
}
async function fixture(localJournal = true) {
  const root = await mkdtemp(join(tmpdir(), "form-cleanup-"));
  roots.push(root);
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  const registry = new PluginFormFileGrants(root);
  await registry.start(localJournal);
  const fs = fakeComputerFiles();
  const authorize = vi.fn().mockResolvedValue(undefined);
  const upload = async (
    owner: PluginFormSource,
    controller = new AbortController(),
  ) => {
    const token = owner.owner.instanceId;
    const result = await registry.upload({
      source: owner,
      token,
      field: "file",
      operationId: crypto.randomUUID(),
      files: [
        {
          name: "binary.bin",
          type: "application/octet-stream",
          bytes: Buffer.from([0, 255, 128]),
        },
      ],
      sourceSignal: controller.signal,
      signal: new AbortController().signal,
      authorize,
      store: createComputerFormFileStore(async () => fs),
    });
    return { ...result, token, controller };
  };
  return { registry, fs, authorize, upload, root };
}

it.each([true, false])(
  "retries cancelled upload cleanup after a transient provider failure (local journal: %s)",
  async (localJournal) => {
    const { registry, fs, authorize, upload, root } =
      await fixture(localJournal);
    const owner = source();
    const result = await upload(owner);
    const remove = vi.spyOn(fs, "remove");
    remove.mockRejectedValueOnce(new Error("Provider unavailable"));
    authorize.mockRejectedValue(new Error("Access revoked"));
    authorize.mockClear();
    result.controller.abort();
    await registry.drain();
    expect(
      [...fs.files.keys()].some((path) => path.endsWith("binary.bin")),
    ).toBe(true);
    expect(() =>
      registry.deliver(owner, result.token, { file: result.uris[0] }),
    ).toThrow();
    registry.closeOwner(owner.owner);
    await registry.drain();
    expect(remove).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await registry.drain();
    expect(fs.files.size).toBe(0);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(authorize).not.toHaveBeenCalled();
    if (!localJournal) expect(await readdir(root)).toEqual([]);
  },
);

it("retains failed closed grants across ticks and only releases their exact owner", async () => {
  const { registry, fs, upload } = await fixture();
  const owner = source("closed");
  const other = source("live");
  const first = await upload(owner);
  const second = await upload(other);
  const firstPath = fileURLToPath(
    registry.deliver(owner, first.token, { file: first.uris[0] })
      .file as string,
  );
  const secondPath = fileURLToPath(
    registry.deliver(other, second.token, { file: second.uris[0] })
      .file as string,
  );
  const firstRoot = firstPath.slice(0, firstPath.indexOf("/files/"));
  const originalRemove = fs.remove;
  let unavailable = true;
  const remove = vi.spyOn(fs, "remove").mockImplementation(async (path) => {
    if (path === firstRoot && unavailable)
      throw new Error("Provider unavailable");
    await originalRemove(path);
  });
  registry.closeOperation(owner.owner, owner.invocationId);
  await registry.drain();
  await vi.advanceTimersByTimeAsync(60_000);
  await registry.drain();
  expect(remove).toHaveBeenCalledTimes(2);
  expect(fs.files.has(firstPath)).toBe(true);
  expect(fs.files.has(secondPath)).toBe(true);
  expect(() =>
    registry.deliver(owner, first.token, { file: first.uris[0] }),
  ).toThrow();
  unavailable = false;
  registry.closeOwner(owner.owner);
  await registry.drain();
  expect(remove).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  await registry.drain();
  expect(fs.files.has(firstPath)).toBe(false);
  expect(fs.files.has(secondPath)).toBe(true);
  registry.closeOwner(other.owner);
  await registry.drain();
  expect(fs.files.size).toBe(0);
});
