import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PluginFormFileGrants,
  pluginFormFileAccepted,
} from "../form-file-grants";
import type { PluginFormSource } from "../form-sources";

const roots: string[] = [];
const registries: PluginFormFileGrants[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const registry of registries.splice(0)) {
    registry.closeOwner(source().owner);
    await registry.drain();
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
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
    origin: "app",
    revision: "tool-rev",
    toolName: "tool",
    parent: { kind: "legacy", id: "parent", round: 0 },
    expiresAt: Date.now() + 10000,
    uploadTarget: "local-stdio",
    fileResources: true,
    requestedSchema: {
      type: "object",
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": {
            type: "resource",
            selection: "implicit",
            options: [{ uri: "fixture://one", name: "One" }],
          },
        },
      },
    },
  };
}
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "mcpjam-form-upload-test-"));
  roots.push(base);
  const registry = new PluginFormFileGrants(base);
  registries.push(registry);
  const current = source();
  const sourceAbort = new AbortController();
  const request = new AbortController();
  const input = {
    source: current,
    token: "opaque",
    field: "files",
    operationId: crypto.randomUUID(),
    files: [
      {
        name: "π.txt",
        type: "text/plain",
        bytes: Buffer.from("π\0\n<script>inert</script>"),
      },
    ],
    sourceSignal: sourceAbort.signal,
    signal: request.signal,
    authorize: vi.fn().mockResolvedValue({}),
  };
  return { base, registry, current, sourceAbort, request, input };
}
describe("original local stdio file grants", () => {
  it.each(["legacy", "mrtr"] as const)(
    "grants one exclusive %s directory preserving hierarchy through source close and terminal cleanup",
    async (kind) => {
      const f = await fixture();
      if (kind === "mrtr")
        f.current.parent = {
          kind,
          id: "parent",
          round: 2,
          inputRequestKey: "key",
        };
      const schema = f.current.requestedSchema as any;
      schema.properties.files.type = "string";
      schema.properties.files.format = "uri";
      delete schema.properties.files.items;
      delete schema.properties.files["x-openai-input"].selection;
      schema.properties.files["x-openai-input"].userOptions = {
        kind: "directory",
        accept: [".txt"],
      };
      const files = ["selected/nested/π.txt", "selected/π.txt"].map(
        (relativePath, index) => ({
          ...f.input.files[0]!,
          relativePath,
          bytes: Buffer.from(`exact ${index} π\0`),
        }),
      );
      const input = { ...f.input, files };
      const first = await f.registry.upload(input);
      expect(first.uris).toHaveLength(1);
      expect(await f.registry.upload(input)).toEqual(first);
      expect(
        await f.registry.upload({ ...input, files: [...files].reverse() }),
      ).toEqual(first);
      await expect(
        f.registry.upload({
          ...input,
          files: files.map((file) => ({
            ...file,
            relativePath: file.relativePath.replace("selected", "changed"),
          })),
        }),
      ).rejects.toThrow();
      const delivery = f.registry.prepareDelivery(f.current, "opaque", {
        files: first.uris[0],
      });
      delivery.assertReady();
      delivery.commit();
      f.sourceAbort.abort();
      const path = fileURLToPath(delivery.content.files as string);
      expect((await stat(path)).mode & 0o777).toBe(0o700);
      expect((await stat(join(path, "nested"))).mode & 0o777).toBe(0o700);
      for (const file of files) {
        const target = join(path, ...file.relativePath.split("/").slice(1));
        expect(await readFile(target)).toEqual(file.bytes);
        expect((await stat(target)).mode & 0o777).toBe(0o600);
      }
      f.registry.closeOperation(f.current.owner, f.current.invocationId);
      await f.registry.drain();
      expect(await readdir(f.base)).toEqual([]);
    },
  );
  it("refuses directory metadata on a file field and applies accept/byte limits to every contained file", async () => {
    const f = await fixture();
    await expect(
      f.registry.upload({
        ...f.input,
        files: [{ ...f.input.files[0]!, relativePath: "selected/π.txt" }],
      }),
    ).rejects.toThrow();
    (f.current.requestedSchema as any).properties.files[
      "x-openai-input"
    ].userOptions = { kind: "directory", accept: [".txt"] };
    for (const file of [
      {
        ...f.input.files[0]!,
        relativePath: "selected/bad.bin",
        name: "bad.bin",
      },
      {
        ...f.input.files[0]!,
        relativePath: "selected/π.txt",
        bytes: new Uint8Array(262145),
      },
    ])
      await expect(
        f.registry.upload({ ...f.input, files: [file] }),
      ).rejects.toThrow();
    expect(await readdir(f.base)).toEqual([]);
  });
  it("prepares MRTR grants without promotion and makes the whole round atomic", async () => {
    const f = await fixture();
    f.current.parent = {
      kind: "mrtr",
      id: "parent",
      round: 1,
      inputRequestKey: "key",
    };
    const result = await f.registry.upload(f.input);
    const delivery = f.registry.prepareDelivery(f.current, "opaque", {
      files: result.uris,
    });
    expect(() =>
      f.registry.prepareDelivery(
        {
          ...f.current,
          parent: {
            kind: "mrtr",
            id: "parent",
            round: 1,
            inputRequestKey: "foreign",
          },
        },
        "opaque",
        { files: result.uris },
      ),
    ).toThrow("FORM_FILE_UNAVAILABLE");
    f.sourceAbort.abort();
    await f.registry.drain();
    expect(() => delivery.assertReady()).toThrow("FORM_FILE_UNAVAILABLE");
    expect(await readdir(f.base)).toEqual([]);
  });
  it("keeps selected MRTR files through old-round close and removes them on confirmed parent settlement", async () => {
    const f = await fixture();
    f.current.parent = {
      kind: "mrtr",
      id: "parent",
      round: 1,
      inputRequestKey: "key",
    };
    const result = await f.registry.upload(f.input);
    const delivery = f.registry.prepareDelivery(f.current, "opaque", {
      files: result.uris,
    });
    delivery.assertReady();
    delivery.commit();
    f.sourceAbort.abort();
    const path = fileURLToPath((delivery.content.files as string[])[0]!);
    expect(await readFile(path)).toEqual(f.input.files[0]!.bytes);
    f.registry.closeSettledMrtrParent("foreign");
    await f.registry.drain();
    expect(await readFile(path)).toEqual(f.input.files[0]!.bytes);
    f.registry.closeSettledMrtrParent("parent");
    await f.registry.drain();
    expect(await readdir(f.base)).toEqual([]);
  });
  it("retains promoted bytes on uncertain wire completion until bounded retention cleanup", async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const result = await f.registry.upload(f.input);
    const answer = f.registry.deliver(f.current, "opaque", {
      files: result.uris,
    });
    f.sourceAbort.abort();
    expect(
      await readFile(fileURLToPath((answer.files as string[])[0]!)),
    ).toEqual(f.input.files[0]!.bytes);
    vi.advanceTimersByTime(30 * 60_000);
    await f.registry.drain();
    expect(await readdir(f.base)).toEqual([]);
  });
  it("preserves legal maximum-length filenames and separates duplicate basenames", async () => {
    const f = await fixture();
    const name = "π".repeat(125) + ".txt";
    const result = await f.registry.upload({
      ...f.input,
      files: [0, 1].map(() => ({ ...f.input.files[0]!, name })),
    });
    const answer = f.registry.deliver(f.current, "opaque", {
      files: result.uris,
    });
    const paths = (answer.files as string[]).map((uri) => fileURLToPath(uri));
    expect(paths[0]).not.toBe(paths[1]);
    expect(paths.every((path) => path.endsWith(name))).toBe(true);
    for (const path of paths)
      expect(await readFile(path)).toEqual(f.input.files[0]!.bytes);
  });
  it("writes exact exclusive bytes, replays one receipt and survives presentation ACK until operation terminal", async () => {
    const f = await fixture();
    const first = await f.registry.upload(f.input);
    expect(first.uris[0]).toMatch(/^mcpjam-form-file:\/\//);
    expect(await f.registry.upload(f.input)).toEqual(first);
    expect(await readdir(f.base)).toHaveLength(1);
    const answer = f.registry.deliver(f.current, "opaque", {
      files: ["fixture://one", ...first.uris],
    });
    const file = fileURLToPath((answer.files as string[])[1]!);
    expect(await readFile(file)).toEqual(f.input.files[0]!.bytes);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    f.sourceAbort.abort();
    await f.registry.drain();
    expect(await readFile(file)).toEqual(f.input.files[0]!.bytes);
    f.registry.closeOperation(f.current.owner, f.current.invocationId);
    await f.registry.drain();
    expect(await readdir(f.base)).toEqual([]);
  });
  it("removes unpromoted files when the source closes", async () => {
    const f = await fixture();
    await f.registry.upload(f.input);
    f.sourceAbort.abort();
    await f.registry.drain();
    expect(await readdir(f.base)).toEqual([]);
  });
  it.each(["bytes", "name", "field"])(
    "refuses a changed %s for the same receipt without repeat placement",
    async (key) => {
      const f = await fixture();
      await f.registry.upload(f.input);
      const changed = {
        ...f.input,
        files: f.input.files.map((file) => ({
          ...file,
          ...(key === "bytes"
            ? { bytes: Buffer.from("changed") }
            : key === "name"
            ? { name: "changed.txt" }
            : {}),
        })),
        ...(key === "field" ? { field: "foreign" } : {}),
      };
      await expect(f.registry.upload(changed)).rejects.toThrow();
      expect(await readdir(f.base)).toHaveLength(1);
    },
  );
  it.each([
    "actorId",
    "projectId",
    "workspaceId",
    "instanceId",
    "generation",
    "serverId",
    "bindingId",
  ])("cannot deliver a URI through another %s", async (key) => {
    const f = await fixture();
    const result = await f.registry.upload(f.input);
    expect(() =>
      f.registry.deliver(
        {
          ...f.current,
          owner: {
            ...f.current.owner,
            [key]: key === "generation" ? 2 : "foreign",
          },
        },
        "opaque",
        { files: result.uris },
      ),
    ).toThrow();
  });
  it("refuses forged URIs, cross-field/parent/source answers and atomically promotes no partial answer", async () => {
    const f = await fixture();
    const result = await f.registry.upload(f.input);
    for (const [current, token, uris] of [
      [f.current, "foreign", result.uris],
      [
        { ...f.current, parent: { kind: "legacy", id: "foreign", round: 0 } },
        "opaque",
        result.uris,
      ],
      [f.current, "opaque", [...result.uris, "file:///private/personal"]],
    ] as const)
      expect(() =>
        f.registry.deliver(current as PluginFormSource, token, { files: uris }),
      ).toThrow();
    f.sourceAbort.abort();
    await f.registry.drain();
    expect(await readdir(f.base)).toEqual([]);
  });
  it.each(["../escape", "a/b", "a\\b", ".", "..", "\0bad"])(
    "refuses unsafe names %j before writing",
    async (name) => {
      const f = await fixture();
      await expect(
        f.registry.upload({
          ...f.input,
          files: [{ ...f.input.files[0]!, name }],
        }),
      ).rejects.toThrow();
      expect(await readdir(f.base)).toEqual([]);
    },
  );
  it("bounds per-file/batch/count before writing and refuses another pending target", async () => {
    const f = await fixture();
    for (const files of [
      [{ ...f.input.files[0]!, bytes: new Uint8Array(262145) }],
      Array.from({ length: 17 }, () => f.input.files[0]!),
      Array.from({ length: 4 }, () => ({
        ...f.input.files[0]!,
        bytes: new Uint8Array(262144),
      })),
    ])
      await expect(f.registry.upload({ ...f.input, files })).rejects.toThrow();
    await expect(
      f.registry.upload({
        ...f.input,
        source: { ...f.current, uploadTarget: undefined },
      }),
    ).rejects.toThrow();
    expect(await readdir(f.base)).toEqual([]);
  });
  it("fences late authorization refusal and request/source closure with actual cleanup", async () => {
    const f = await fixture();
    f.input.authorize
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("pending closed"));
    await expect(f.registry.upload(f.input)).rejects.toThrow();
    await f.registry.drain();
    expect(await readdir(f.base)).toEqual([]);
  });
});

describe("userOptions.accept", () => {
  it.each([
    [{ name: "part.STL", type: "" }, [".stl"], true],
    [{ name: "part.step", type: "" }, [".stl", ".step"], true],
    [{ name: "part.obj", type: "" }, [".stl"], false],
    [{ name: "a.png", type: "image/png" }, ["image/*"], true],
    [{ name: "a.png", type: "image/png" }, ["IMAGE/*"], true],
    [{ name: "a.png", type: "image/png" }, ["image/PNG"], true],
    [{ name: "a.txt", type: "text/plain" }, ["image/*"], false],
    [{ name: "a.txt", type: "" }, ["text/plain"], false],
    [{ name: "anything.bin", type: "" }, undefined, true],
  ])("%j against %j: %s", (file, accept, ok) => {
    expect(pluginFormFileAccepted(file, accept)).toBe(ok);
  });
});
