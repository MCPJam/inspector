import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  symlink,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalFileTargetAdapter,
  admitLocalFileTargetContract,
  resolveLocalFileTarget,
  resolveLocalFilePath,
} from "../local-file-target.js";
import { pluginBindingDigest } from "../bindings.js";
import { createPluginFileResourceSession } from "../file-resource-session.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots.length = 0;
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "mcpjam-owned-file-test-")),
  );
  roots.push(root);
  await writeFile(path.join(root, "part.cad"), "synthetic 🧩\0");
  const target = resolveLocalFileTarget(
    {
      version: 1,
      targets: [
        {
          serverId: "saved",
          root,
          exclusiveWrites: true,
          resources: [{ uri: "cad://part", relativePath: "part.cad" }],
        },
      ],
    },
    "saved",
    "cad://part",
  )!;
  const adapter = createLocalFileTargetAdapter(target);
  return { root, target, adapter };
}
describe("explicit saved local target", () => {
  it("requires operator-owned actor/project/server/root authority before user config can select files", () => {
    const identity = { actorId: "a", projectId: "p", serverId: "s" };
    const contract = {
      version: 1,
      targets: [
        {
          serverId: "s",
          root: "/private-fixture",
          exclusiveWrites: true,
          resources: [],
        },
      ],
    };
    expect(
      admitLocalFileTargetContract(contract, identity, ""),
    ).toBeUndefined();
    expect(
      admitLocalFileTargetContract(
        contract,
        identity,
        JSON.stringify([
          { ...identity, actorId: "other", root: "/private-fixture" },
        ]),
      ),
    ).toBeUndefined();
    expect(
      admitLocalFileTargetContract(
        contract,
        identity,
        JSON.stringify([
          { ...identity, projectId: "other", root: "/private-fixture" },
        ]),
      ),
    ).toBeUndefined();
    expect(
      admitLocalFileTargetContract(
        contract,
        identity,
        JSON.stringify([{ ...identity, root: "/elsewhere" }]),
      ),
    ).toBeUndefined();
    expect(
      admitLocalFileTargetContract(
        contract,
        identity,
        JSON.stringify([{ ...identity, root: "/private-fixture" }]),
      ),
    ).toEqual(contract);
  });
  it("requires an exact server resource mapping and exclusive-write contract", () => {
    expect(
      resolveLocalFileTarget(undefined, "saved", "cad://part"),
    ).toBeUndefined();
    expect(() =>
      resolveLocalFileTarget(
        {
          version: 1,
          targets: [{ serverId: "saved", root: "/tmp", resources: [] }],
        },
        "saved",
        "cad://part",
      ),
    ).toThrow();
    expect(() =>
      resolveLocalFileTarget(
        {
          version: 1,
          targets: [
            {
              serverId: "saved",
              root: "/tmp",
              exclusiveWrites: true,
              resources: [{ uri: "cad://part", relativePath: "../escape" }],
            },
          ],
        },
        "saved",
        "cad://part",
      ),
    ).toThrow();
  });
  it("preserves target authority across durable schema key ordering", async () => {
    const { target } = await fixture();
    const restored = {
      root: target.root,
      relativePath: target.relativePath,
      uri: target.uri,
      exclusiveWrites: target.exclusiveWrites,
    };
    expect(JSON.stringify(restored)).not.toBe(JSON.stringify(target));
    expect(pluginBindingDigest(restored)).toBe(pluginBindingDigest(target));
    expect(
      pluginBindingDigest({ ...restored, relativePath: "foreign.cad" }),
    ).not.toBe(pluginBindingDigest(target));
  });
  it("reads exact bytes, saves with ETag and leaves stale writes unchanged", async () => {
    const { root, adapter } = await fixture();
    const signal = new AbortController().signal;
    const first = await adapter.read("cad://part", signal);
    expect(new TextDecoder().decode(first.bytes)).toBe("synthetic 🧩\0");
    const next = new TextEncoder().encode("saved\0 bytes");
    expect(
      await adapter.conditionalWrite!("cad://part", next, first.etag, signal),
    ).toMatchObject({ outcome: "saved" });
    expect(
      await adapter.conditionalWrite!(
        "cad://part",
        new Uint8Array([1]),
        first.etag,
        signal,
      ),
    ).toMatchObject({ outcome: "conflict" });
    expect(await readFile(path.join(root, "part.cad"), "utf8")).toBe(
      "saved\0 bytes",
    );
  });
  it("serializes concurrent CAS and resolves only exact configured local paths", async () => {
    const { root, target, adapter } = await fixture();
    const signal = new AbortController().signal;
    const first = await adapter.read(target.uri, signal);
    const results = await Promise.all([
      adapter.conditionalWrite!(
        target.uri,
        new Uint8Array([1]),
        first.etag,
        signal,
      ),
      adapter.conditionalWrite!(
        target.uri,
        new Uint8Array([2]),
        first.etag,
        signal,
      ),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "conflict",
      "saved",
    ]);
    const contract = {
      version: 1,
      targets: [
        {
          serverId: "saved",
          root,
          exclusiveWrites: true,
          resources: [{ uri: target.uri, relativePath: target.relativePath }],
        },
      ],
    };
    expect(
      resolveLocalFilePath(
        contract,
        "saved",
        path.join(root, target.relativePath),
      ),
    ).toEqual(target);
    expect(
      resolveLocalFilePath(contract, "saved", "/etc/hosts"),
    ).toBeUndefined();
  });
  it("refuses symlinks and keys outside the saved target", async () => {
    const { root, adapter } = await fixture();
    const signal = new AbortController().signal;
    await expect(adapter.read("cad://other", signal)).rejects.toThrow();
    await rm(path.join(root, "part.cad"));
    await symlink("/etc/hosts", path.join(root, "part.cad"));
    await expect(adapter.read("cad://part", signal)).rejects.toThrow();
  });
  it("delivers actual file notifications and stops watching on close", async () => {
    const { adapter } = await fixture();
    const controller = new AbortController();
    const changed = vi.fn();
    const stop = await adapter.watch!("cad://part", changed, controller.signal);
    const first = await adapter.read("cad://part", controller.signal);
    await adapter.conditionalWrite!(
      "cad://part",
      new Uint8Array([2]),
      first.etag,
      controller.signal,
    );
    await vi.waitFor(() => expect(changed).toHaveBeenCalled());
    stop();
    controller.abort();
  });
  it("uses actual scoped grants for writable read, save, stale conflict and trusted metadata", async () => {
    const { adapter, target } = await fixture();
    const controller = new AbortController();
    const session = createPluginFileResourceSession({
      owner: {
        actorId: "actor",
        projectId: "project",
        subject: "subject",
        workspaceId: "workspace",
        instanceId: "instance",
        generation: 1,
        serverId: "saved",
        bindingId: "binding",
      },
      signal: controller.signal,
      assertLive() {},
      authorize: async () => {},
      resource: {
        key: target.uri,
        name: "part.cad",
        privatePath: path.join(target.root, target.relativePath),
        adapter,
        maxBytes: 1024,
        authorizeWrite: async () => {},
      },
    });
    const result = await session.read({ uri: session.input.file.resourceUri });
    const etag = (
      result.contents[0]._meta?.["openai/resource"] as { etag: string }
    ).etag;
    expect(
      await session.write(crypto.randomUUID(), {
        uri: session.input.file.resourceUri,
        text: "saved",
        ifMatch: etag,
      }),
    ).toMatchObject({ outcome: "saved" });
    expect(
      await session.write(crypto.randomUUID(), {
        uri: session.input.file.resourceUri,
        text: "stale",
        ifMatch: etag,
      }),
    ).toMatchObject({ outcome: "conflict" });
    expect((await session.toolMetadata())["openai/resource"]).toEqual({
      path: path.join(target.root, target.relativePath),
    });
    controller.abort();
  });
});
