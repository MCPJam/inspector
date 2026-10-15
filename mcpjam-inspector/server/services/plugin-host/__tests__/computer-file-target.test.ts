import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  admitComputerFileTargetContract,
  createComputerFileTargetAdapter,
  createProjectComputerConnector,
  pluginComputerUploadsAvailable,
  resolveComputerFilePath,
} from "../computer-file-target.js";
import { pluginFileTargets } from "../file-targets.js";
import { OwnedFileResources } from "../owned-file-resources.js";
import type { PluginPreviewInstance } from "../instances.js";
import { fakeComputerFiles } from "../testing/fake-computer-files.js";

const sha = (text: string) =>
  createHash("sha256").update(new TextEncoder().encode(text)).digest("hex");
const target = {
  root: "/home/user/parts",
  relativePath: "bolt.stl",
  uri: "cad://bolt",
  exclusiveWrites: true as const,
};
const contract = (root = "/home/user/parts") => ({
  version: 1,
  targets: [
    {
      serverId: "server",
      root,
      exclusiveWrites: true,
      resources: [{ uri: "cad://bolt", relativePath: "bolt.stl" }],
    },
  ],
});
const signal = () => AbortSignal.timeout(5000);

describe("Computer file target admission", () => {
  it("admits roots under the box home only", () => {
    expect(admitComputerFileTargetContract(contract(), "server")).toEqual(
      contract(),
    );
    for (const root of ["/etc", "/home/user2/x", "/home/user/../etc", "/home/user/parts/"])
      expect(admitComputerFileTargetContract(contract(root), "server")).toBe(
        undefined,
      );
    expect(admitComputerFileTargetContract(contract(), "other")).toBe(
      undefined,
    );
  });
  it("resolves an opened path on the VM within the admitted roots", () => {
    const admitted = admitComputerFileTargetContract(contract(), "server");
    expect(
      resolveComputerFilePath(admitted, "server", "/home/user/parts/bolt.stl"),
    ).toMatchObject({ uri: "cad://bolt" });
    expect(
      resolveComputerFilePath(admitted, "server", "/home/user/parts/../parts/bolt.stl"),
    ).toBeUndefined();
    expect(
      resolveComputerFilePath(admitted, "server", "/home/user/parts/nut.stl"),
    ).toBeUndefined();
  });
  it.each([
    [{ transport: "stdio", computer: true }, undefined],
    [{ transport: "http", computer: true }, "PLUGIN_FILES_REMOTE_SERVER"],
    [{ transport: "stdio", computer: false }, "PLUGIN_FILES_COMPUTER_REQUIRED"],
  ] as const)("places hosted targets on the Computer (%j)", (input, unavailable) => {
    const targets = pluginFileTargets({
      contract: contract(),
      identity: { actorId: "a", projectId: "p", serverId: "server" },
      hosted: true,
      ...input,
    });
    expect(targets.placement).toBe("computer");
    expect(targets.unavailable).toBe(unavailable);
    expect(!!targets.contract).toBe(!unavailable);
  });
  it("offers Computer uploads only for hosted stdio servers with a Computer", () => {
    expect(
      pluginComputerUploadsAvailable({ hosted: true, computer: true, transport: "stdio" }),
    ).toBe(true);
    for (const input of [
      { hosted: false, computer: true, transport: "stdio" },
      { hosted: true, computer: false, transport: "stdio" },
      { hosted: true, computer: true, transport: "http" },
      { hosted: true, computer: true },
    ])
      expect(pluginComputerUploadsAvailable(input)).toBe(false);
  });
  it("explains a Computer root outside the box home", () => {
    expect(
      pluginFileTargets({
        contract: contract("/srv/parts"),
        identity: { actorId: "a", projectId: "p", serverId: "server" },
        hosted: true,
        transport: "stdio",
        computer: true,
      }).unavailable,
    ).toBe("PLUGIN_COMPUTER_FILE_ROOT_INVALID");
  });
});

describe("Computer file target adapter", () => {
  it("reads bytes with a sha256 etag and refuses links, folders and oversize files", async () => {
    const fs = fakeComputerFiles({ "/home/user/parts/bolt.stl": "solid bolt" });
    const adapter = createComputerFileTargetAdapter(target, async () => fs, 64);
    const read = await adapter.read("cad://bolt", signal());
    expect(new TextDecoder().decode(read.bytes)).toBe("solid bolt");
    expect(read.etag).toBe(sha("solid bolt"));
    await expect(adapter.read("cad://other", signal())).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
    fs.symlinks.add("/home/user/parts/bolt.stl");
    await expect(adapter.read("cad://bolt", signal())).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
    fs.symlinks.clear();
    fs.files.set("/home/user/parts/bolt.stl", new Uint8Array(65));
    await expect(adapter.read("cad://bolt", signal())).rejects.toMatchObject({
      code: "RESOURCE_TOO_LARGE",
    });
    fs.files.delete("/home/user/parts/bolt.stl");
    await expect(adapter.read("cad://bolt", signal())).rejects.toMatchObject({
      code: "RESOURCE_DENIED",
    });
  });

  it("compares then writes through a temporary file and honors ifMatch", async () => {
    const fs = fakeComputerFiles({ "/home/user/parts/bolt.stl": "v1" });
    const adapter = createComputerFileTargetAdapter(target, async () => fs);
    const encode = (text: string) => new TextEncoder().encode(text);
    await expect(
      adapter.conditionalWrite!("cad://bolt", encode("v2"), sha("stale"), signal()),
    ).resolves.toEqual({ outcome: "conflict", etag: sha("v1") });
    await expect(
      adapter.conditionalWrite!("cad://bolt", encode("v2"), sha("v1"), signal()),
    ).resolves.toEqual({ outcome: "saved", etag: sha("v2") });
    expect(new TextDecoder().decode(fs.files.get("/home/user/parts/bolt.stl")))
      .toBe("v2");
    expect(
      [...fs.files.keys()].filter((path) => path.includes(".mcpjam-save-")),
    ).toEqual([]);
    expect(fs.calls.some((call) => call.startsWith("rename /home/user/parts/.mcpjam-save-"))).toBe(true);
  });

  it("refuses to replace a file that changed after the comparison", async () => {
    const fs = fakeComputerFiles({ "/home/user/parts/bolt.stl": "v1" });
    const adapter = createComputerFileTargetAdapter(target, async () => fs);
    const write = fs.write.bind(fs);
    fs.write = async (path, data) => {
      await write(path, data);
      // Another writer outside this process replaces the file mid-save.
      fs.files.set("/home/user/parts/bolt.stl", new TextEncoder().encode("theirs"));
    };
    await expect(
      adapter.conditionalWrite!(
        "cad://bolt",
        new TextEncoder().encode("mine"),
        sha("v1"),
        signal(),
      ),
    ).resolves.toEqual({ outcome: "conflict", etag: sha("theirs") });
    expect(new TextDecoder().decode(fs.files.get("/home/user/parts/bolt.stl")))
      .toBe("theirs");
  });

  it("serializes writers to one path in this process", async () => {
    const fs = fakeComputerFiles({ "/home/user/parts/bolt.stl": "v1" });
    const adapter = createComputerFileTargetAdapter(target, async () => fs);
    const encode = (text: string) => new TextEncoder().encode(text);
    const [first, second] = await Promise.all([
      adapter.conditionalWrite!("cad://bolt", encode("a"), sha("v1"), signal()),
      adapter.conditionalWrite!("cad://bolt", encode("b"), sha("v1"), signal()),
    ]);
    expect(first).toEqual({ outcome: "saved", etag: sha("a") });
    expect(second).toEqual({ outcome: "conflict", etag: sha("a") });
  });
});

describe("project Computer connector", () => {
  const ready = vi.fn();
  const info = vi.fn();
  const connect = vi.fn();
  const connector = (configured = true) =>
    createProjectComputerConnector("server", {
      ready,
      info,
      connect,
      configured: () => configured,
    });
  const input = { bearer: "b", projectId: "p" };
  it("connects to the caller's own Computer", async () => {
    const fs = fakeComputerFiles();
    ready.mockResolvedValueOnce({ ok: true, value: { computerId: "c1" } });
    info.mockResolvedValueOnce({
      ok: true,
      value: { providerComputerId: "sandbox-1" },
    });
    connect.mockResolvedValueOnce(fs);
    await expect(connector()(input)).resolves.toBe(fs);
    expect(connect).toHaveBeenCalledWith("sandbox-1");
    expect(ready.mock.calls[0][0]).toMatchObject({ timeoutMs: 10_000 });
  });
  it.each([
    ["not configured", () => {}, false],
    [
      "asleep",
      () => ready.mockResolvedValueOnce({ ok: false, status: 503 }),
      true,
    ],
    [
      "still provisioning",
      () => {
        ready.mockResolvedValueOnce({ ok: true, value: { computerId: "c1" } });
        info.mockResolvedValueOnce({ ok: true, value: {} });
      },
      true,
    ],
    [
      "unreachable",
      () => {
        ready.mockResolvedValueOnce({ ok: true, value: { computerId: "c1" } });
        info.mockResolvedValueOnce({
          ok: true,
          value: { providerComputerId: "sandbox-1" },
        });
        connect.mockRejectedValueOnce(new Error("timeout"));
      },
      true,
    ],
  ])("reports a %s Computer as a described 503", async (_, arrange, configured) => {
    arrange();
    await expect(connector(configured)(input)).rejects.toMatchObject({
      code: "PLUGIN_COMPUTER_UNAVAILABLE",
      status: 503,
      diagnostics: [
        expect.objectContaining({
          level: "error",
          serverId: "server",
          description: expect.stringContaining("asleep or unreachable"),
        }),
      ],
    });
  });
});

describe("owned file sessions on the Computer", () => {
  const instance = {
    owner: {
      actorId: "a",
      projectId: "p",
      workspaceId: "w",
      instanceId: "computer-instance",
      generation: 1,
      serverId: "server",
      bindingId: "b",
      placement: "interactive",
    },
    subject: "s",
    activation: {
      file: {
        kind: "saved-resource",
        version: 1,
        uri: "cad://bolt",
        name: "bolt.stl",
        localTarget: target,
      },
    },
  } as PluginPreviewInstance;
  it("reads and saves through this request's Computer and gives tools the VM path", async () => {
    const fs = fakeComputerFiles({ "/home/user/parts/bolt.stl": "v1" });
    const resources = new OwnedFileResources(() => "computer");
    const lifetime = new AbortController();
    try {
      const session = resources.get(instance, lifetime.signal);
      expect(session.capabilities).toEqual({ write: true, subscribe: false });
      const ports = {
        authorize: async () => {},
        read: async () => {
          throw new Error("unused");
        },
        computer: async () => fs,
      };
      const uri = session.input.file.resourceUri;
      const read = await resources.run(instance, ports, () =>
        session.read({ uri }, signal()),
      );
      expect(read.contents[0]).toMatchObject({ text: "v1" });
      await resources.run(instance, ports, () =>
        session.write(
          "11111111-1111-4111-8111-111111111111",
          { uri, text: "v2", ifMatch: sha("v1") },
          signal(),
        ),
      );
      expect(new TextDecoder().decode(fs.files.get("/home/user/parts/bolt.stl")))
        .toBe("v2");
      const metadata = await resources.run(instance, ports, () =>
        session.toolMetadata({}),
      );
      expect(JSON.stringify(metadata)).toContain("/home/user/parts/bolt.stl");
      await expect(
        resources.run(instance, { ...ports, computer: undefined }, () =>
          session.read({ uri }, signal()),
        ),
      ).rejects.toMatchObject({ code: "PLUGIN_COMPUTER_UNAVAILABLE" });
    } finally {
      lifetime.abort();
    }
  });
});
