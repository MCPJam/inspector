import { describe, it, expect, beforeAll, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  buildPluginZip,
  createMemoryPluginFileSource,
  filesFromFolderSelection,
  parsePluginBundleFromFiles,
  zipToPluginFiles,
  type PluginBundleFile,
} from "../folder-bundle";
import { resolveJsonServerMap } from "../../json-config-parser";

// The SDK plugin-bundle hashes go through Web Crypto; jsdom does not always
// provide `crypto.subtle`, Node's webcrypto is byte-identical.
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    vi.stubGlobal("crypto", webcrypto);
  }
});

const encoder = new TextEncoder();

function textFile(path: string, content: string): PluginBundleFile {
  return { path, bytes: encoder.encode(content) };
}

const MANIFEST = textFile(
  ".codex-plugin/plugin.json",
  JSON.stringify({ name: "demo-plugin", display_name: "Demo Plugin" }),
);

const MCP_SERVERS = {
  demo: { url: "https://example.com/mcp" },
  local: { command: "node", args: ["server.js"] },
};

function bundleFiles(mcpConfigDocument: unknown): PluginBundleFile[] {
  return [MANIFEST, textFile(".mcp.json", JSON.stringify(mcpConfigDocument))];
}

describe("parsePluginBundleFromFiles", () => {
  it("parses a minimal bundle and reports a content-defined bundle hash", async () => {
    const parsed = await parsePluginBundleFromFiles(
      bundleFiles({ mcpServers: MCP_SERVERS }),
    );
    expect(parsed.manifest.name).toBe("demo-plugin");
    expect(parsed.bundleHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.mcpServers.map((server) => server.key).sort()).toEqual([
      "demo",
      "local",
    ]);
  });

  it("accepts direct, mcp_servers, and mcpServers shapes identically (SDK parity)", async () => {
    const shapes: unknown[] = [
      MCP_SERVERS,
      { mcp_servers: MCP_SERVERS },
      { mcpServers: MCP_SERVERS },
    ];
    const parsedKeys: string[][] = [];
    for (const shape of shapes) {
      const parsed = await parsePluginBundleFromFiles(bundleFiles(shape));
      parsedKeys.push(parsed.mcpServers.map((server) => server.key).sort());

      // The inspector's JSON import resolves the same shapes to the same
      // server names — the two code paths agree on shape detection.
      const resolved = resolveJsonServerMap(shape);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(Object.keys(resolved.servers).sort()).toEqual(["demo", "local"]);
      }
    }
    expect(parsedKeys[1]).toEqual(parsedKeys[0]);
    expect(parsedKeys[2]).toEqual(parsedKeys[0]);
  });
});

describe("folder / ZIP bundle hash parity", () => {
  const files = [
    MANIFEST,
    textFile(".mcp.json", JSON.stringify({ mcp_servers: MCP_SERVERS })),
    textFile(
      "skills/demo/SKILL.md",
      "---\nname: demo\ndescription: A demo skill for parity tests\n---\nBody\n",
    ),
  ];

  it("a folder and a ZIP of identical contents produce the same bundle hash", async () => {
    const folderParsed = await parsePluginBundleFromFiles(files);

    const zipBytes = await buildPluginZip(files);
    const roundTripped = await zipToPluginFiles(zipBytes);
    const zipParsed = await parsePluginBundleFromFiles(roundTripped);

    expect(zipParsed.bundleHash).toBe(folderParsed.bundleHash);
    expect(zipParsed.manifestHash).toBe(folderParsed.manifestHash);
  });

  it("bundle hash is independent of file listing order", async () => {
    const reversed = [...files].reverse();
    const a = await parsePluginBundleFromFiles(files);
    const b = await parsePluginBundleFromFiles(reversed);
    expect(b.bundleHash).toBe(a.bundleHash);
  });

  it("zipping the same files twice is deterministic", async () => {
    const first = await buildPluginZip(files);
    const second = await buildPluginZip([...files].reverse());
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });
});

describe("filesFromFolderSelection", () => {
  function pickedFile(relativePath: string, content: string): File {
    const file = new File([content], relativePath.split("/").pop() ?? "");
    Object.defineProperty(file, "webkitRelativePath", {
      value: relativePath,
    });
    return file;
  }

  it("strips the shared picked-folder segment and filters OS junk", async () => {
    const files = await filesFromFolderSelection([
      pickedFile("my-plugin/.codex-plugin/plugin.json", "{}"),
      pickedFile("my-plugin/.mcp.json", "{}"),
      pickedFile("my-plugin/.DS_Store", "junk"),
      pickedFile("my-plugin/__MACOSX/resource", "junk"),
    ]);
    expect(files.map((file) => file.path).sort()).toEqual([
      ".codex-plugin/plugin.json",
      ".mcp.json",
    ]);
  });

  it("keeps paths as-is when entries do not share a single root", async () => {
    const files = await filesFromFolderSelection([
      pickedFile("a/one.txt", "1"),
      pickedFile("b/two.txt", "2"),
    ]);
    expect(files.map((file) => file.path).sort()).toEqual([
      "a/one.txt",
      "b/two.txt",
    ]);
  });
});

describe("createMemoryPluginFileSource", () => {
  it("lists files and serves exact bytes", async () => {
    const source = createMemoryPluginFileSource([textFile("a.txt", "hello")]);
    const entries = await source.list();
    expect(entries).toEqual([{ path: "a.txt", size: 5, kind: "file" }]);
    expect(
      new TextDecoder().decode(await source.readBytes("a.txt", 1024)),
    ).toBe("hello");
    await expect(source.readBytes("missing.txt", 1024)).rejects.toThrow(
      "no such bundle file",
    );
  });
});
