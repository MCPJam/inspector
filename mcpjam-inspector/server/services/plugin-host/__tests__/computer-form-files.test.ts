import { afterEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { PluginFormFileGrants } from "../form-file-grants.js";
import type { PluginFormSource } from "../form-sources.js";
import {
  COMPUTER_FORM_UPLOAD_ROOT,
  createComputerFormFileStore,
} from "../computer-form-files.js";
import { fakeComputerFiles } from "../testing/fake-computer-files.js";

const registries: PluginFormFileGrants[] = [];
afterEach(async () => {
  for (const registry of registries.splice(0)) {
    registry.closeOwner(source().owner);
    await registry.drain();
  }
});
const fixedSource = { expiresAt: Date.now() + 60 * 60_000 };
function source(): PluginFormSource {
  return {
    owner: {
      actorId: "actor",
      projectId: "project",
      workspaceId: "workspace",
      instanceId: "instance",
      generation: 1,
      serverId: "server",
      bindingId: "binding",
      placement: "interactive",
    },
    hostId: "host",
    hostRevision: "host-rev",
    invocationId: "operation",
    origin: "model",
    revision: "tool-rev",
    toolName: "tool",
    parent: { kind: "legacy", id: "parent", round: 0 },
    expiresAt: fixedSource.expiresAt,
    uploadTarget: "computer",
    requestedSchema: {
      type: "object",
      required: ["file"],
      properties: {
        file: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            options: [],
            userOptions: { kind: "file", accept: [".stl"] },
          },
        },
      },
    },
  };
}
function upload(
  registry: PluginFormFileGrants,
  fs: ReturnType<typeof fakeComputerFiles>,
  now = () => Date.now(),
) {
  return registry.upload({
    source: source(),
    token: "opaque",
    field: "file",
    operationId: crypto.randomUUID(),
    files: [
      { name: "bolt.stl", type: "model/stl", bytes: Buffer.from("solid") },
    ],
    sourceSignal: new AbortController().signal,
    signal: new AbortController().signal,
    authorize: vi.fn().mockResolvedValue({}),
    store: createComputerFormFileStore(async () => fs, now),
  });
}

describe("form uploads on the project's Computer", () => {
  it("places the file under ~/.mcpjam/form-uploads with a journal entry and delivers its VM path", async () => {
    const fs = fakeComputerFiles();
    const registry = new PluginFormFileGrants();
    registries.push(registry);
    const { uris } = await upload(registry, fs);
    expect(uris).toHaveLength(1);
    expect(uris[0]).toMatch(/^mcpjam-form-file:\/\//);
    const delivered = registry.deliver(source(), "opaque", { file: uris[0] });
    const path = fileURLToPath(delivered.file as string);
    expect(path.startsWith(`${COMPUTER_FORM_UPLOAD_ROOT}/mcpjam-form-`)).toBe(
      true,
    );
    expect(path.endsWith("/bolt.stl")).toBe(true);
    expect(new TextDecoder().decode(fs.files.get(path))).toBe("solid");
    const folder = path.slice(0, path.indexOf("/files/"));
    const marker = JSON.parse(
      new TextDecoder().decode(fs.files.get(`${folder}/ownership.json`)),
    );
    expect(marker).toMatchObject({
      version: 1,
      name: folder.split("/").at(-1),
      bytes: 5,
    });
    expect(marker.expiresAt - marker.createdAt).toBe(30 * 60_000);
  });

  it("sweeps only expired journal entries, at the next upload", async () => {
    let now = 1_000_000;
    const fs = fakeComputerFiles({
      [`${COMPUTER_FORM_UPLOAD_ROOT}/notes/keep.txt`]: "not ours",
    });
    const store = createComputerFormFileStore(async () => fs, () => now);
    const first = await store.reserve("key", 5);
    await store.writeNew(`${first.payload}/a.txt`, Buffer.from("a"));
    const malformed = `${COMPUTER_FORM_UPLOAD_ROOT}/mcpjam-form-00000000-0000-4000-8000-000000000000`;
    fs.files.set(`${malformed}/ownership.json`, Buffer.from("{"));
    now += 30 * 60_000 - 1;
    expect(await store.sweep()).toBe(0);
    now += 2;
    expect(await store.sweep()).toBe(1);
    expect(fs.files.has(`${first.payload}/a.txt`)).toBe(false);
    expect(fs.files.has(`${COMPUTER_FORM_UPLOAD_ROOT}/notes/keep.txt`)).toBe(
      true,
    );
    expect(fs.files.has(`${malformed}/ownership.json`)).toBe(true);
    // An upload runs the sweep first, best effort.
    const registry = new PluginFormFileGrants();
    registries.push(registry);
    const second = await store.reserve("key", 1);
    now += 31 * 60_000;
    await upload(registry, fs, () => now);
    expect([...fs.files.keys()].some((key) => key.startsWith(second.root))).toBe(
      false,
    );
  });

  it("never overwrites an existing file", async () => {
    const fs = fakeComputerFiles({ "/home/user/.mcpjam/form-uploads/x/y": "z" });
    const store = createComputerFormFileStore(async () => fs);
    await expect(
      store.writeNew("/home/user/.mcpjam/form-uploads/x/y", Buffer.from("q")),
    ).rejects.toMatchObject({ code: "FORM_FILE_UNAVAILABLE" });
  });

  it("keeps local placement for local stdio sources", async () => {
    const registry = new PluginFormFileGrants();
    registries.push(registry);
    await expect(
      registry.upload({
        ...{
          source: { ...source(), uploadTarget: undefined },
          token: "opaque",
          field: "file",
          operationId: crypto.randomUUID(),
          files: [],
          sourceSignal: new AbortController().signal,
          signal: new AbortController().signal,
          authorize: vi.fn(),
        },
      }),
    ).rejects.toMatchObject({ code: "FORM_FILE_UNAVAILABLE" });
  });
});
