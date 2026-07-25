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

  it("enforces maxBytes (throws instead of returning oversized data)", async () => {
    const source = createMemoryPluginFileSource([textFile("a.txt", "hello")]);
    await expect(source.readBytes("a.txt", 4)).rejects.toThrow("read limit");
  });
});

describe("zipToPluginFiles zip-bomb hardening", () => {
  // Highly compressible payload: 64 KiB of zeros deflates to ~100 bytes, so
  // a "bomb" fixture stays tiny on the compressed side while tripping the
  // (overridden, small) uncompressed limits during extraction.
  const compressible = (bytes: number): PluginBundleFile => ({
    path: "big.bin",
    bytes: new Uint8Array(bytes), // all zeros
  });

  it("rejects an entry whose uncompressed size exceeds maxFileBytes before inflating it", async () => {
    const zip = await buildPluginZip([MANIFEST, compressible(64 * 1024)]);
    await expect(
      zipToPluginFiles(zip, { limits: { maxFileBytes: 16 * 1024 } }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "FILE_TOO_LARGE",
    });
  });

  it("rejects when cumulative uncompressed content exceeds maxTotalBytes", async () => {
    const zip = await buildPluginZip([
      MANIFEST,
      { path: "a.bin", bytes: new Uint8Array(32 * 1024) },
      { path: "b.bin", bytes: new Uint8Array(32 * 1024) },
    ]);
    await expect(
      zipToPluginFiles(zip, {
        limits: { maxFileBytes: 40 * 1024, maxTotalBytes: 48 * 1024 },
      }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_LARGE",
    });
  });

  it("rejects an archive with too many entries before reading any of them", async () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      textFile(`file-${i}.txt`, String(i)),
    );
    const zip = await buildPluginZip(many);
    await expect(
      zipToPluginFiles(zip, { limits: { maxEntries: 4 } }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_MANY_ENTRIES",
    });
  });

  it("extracts a compliant archive under the default limits", async () => {
    const zip = await buildPluginZip([MANIFEST]);
    const files = await zipToPluginFiles(zip);
    expect(files.map((file) => file.path)).toEqual([
      ".codex-plugin/plugin.json",
    ]);
  });

  /**
   * Overwrite the uncompressed-size field of `fileName`'s central-directory
   * header (PK\x01\x02, size at offset 24, name at offset 46) so the archive
   * LIES about how big the entry inflates to.
   */
  function forgeDeclaredSize(
    zipBytes: Uint8Array,
    fileName: string,
    forgedSize: number,
  ): Uint8Array {
    const out = new Uint8Array(zipBytes);
    const view = new DataView(out.buffer);
    const nameBytes = encoder.encode(fileName);
    for (let i = 0; i + 46 <= out.length; i++) {
      if (
        out[i] === 0x50 &&
        out[i + 1] === 0x4b &&
        out[i + 2] === 0x01 &&
        out[i + 3] === 0x02
      ) {
        const nameLen = view.getUint16(i + 28, true);
        const name = out.subarray(i + 46, i + 46 + nameLen);
        if (
          nameLen === nameBytes.length &&
          name.every((byte, j) => byte === nameBytes[j])
        ) {
          view.setUint32(i + 24, forgedSize, true);
          return out;
        }
      }
    }
    throw new Error(`central-directory header for ${fileName} not found`);
  }

  it("aborts mid-stream when the declared size is forged below the cap", async () => {
    // 64 KiB of zeros, but the central directory claims 10 bytes — the
    // declared-size fast-fail passes, so only the bounded stream can stop it.
    const zip = await buildPluginZip([MANIFEST, compressible(64 * 1024)]);
    const forged = forgeDeclaredSize(zip, "big.bin", 10);
    await expect(
      zipToPluginFiles(forged, { limits: { maxFileBytes: 16 * 1024 } }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "FILE_TOO_LARGE",
      message: expect.stringContaining("during extraction"),
    });
  });

  it("counts directory records toward maxEntries (backend parity)", async () => {
    // The backend rejects on the end-of-central-directory RECORD count before
    // filtering, so directory records must count here too. jszip's default
    // createFolders:true emits a "a/" directory record alongside the file.
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    zip.file("a/one.txt", "1");
    const bytes = await zip.generateAsync({ type: "uint8array" });
    await expect(
      zipToPluginFiles(bytes, { limits: { maxEntries: 1 } }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_MANY_ENTRIES",
    });
  });

  it("uploads built by buildPluginZip contain file records only", async () => {
    const zip = await buildPluginZip([
      MANIFEST,
      textFile("skills/demo/SKILL.md", "x"),
    ]);
    const { default: JSZip } = await import("jszip");
    const loaded = await JSZip.loadAsync(zip);
    expect(
      Object.values(loaded.files).filter((entry) => entry.dir),
    ).toHaveLength(0);
  });
});

describe("filesFromFolderSelection pre-read limits", () => {
  function fakeFile(path: string, size: number): File {
    const file = new File(["x"], path.split("/").pop() ?? "");
    Object.defineProperty(file, "webkitRelativePath", { value: path });
    Object.defineProperty(file, "size", { value: size });
    Object.defineProperty(file, "arrayBuffer", {
      value: vi.fn(async () => new ArrayBuffer(size)),
    });
    return file;
  }

  it("rejects an oversized file from metadata without reading it", async () => {
    const big = fakeFile("plugin/big.bin", 2048);
    await expect(
      filesFromFolderSelection([big], { limits: { maxFileBytes: 1024 } }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "FILE_TOO_LARGE",
    });
    expect(big.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects too many files before reading any", async () => {
    const files = [fakeFile("plugin/a.txt", 1), fakeFile("plugin/b.txt", 1)];
    await expect(
      filesFromFolderSelection(files, { limits: { maxEntries: 1 } }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_MANY_ENTRIES",
    });
    for (const file of files) {
      expect(file.arrayBuffer).not.toHaveBeenCalled();
    }
  });

  it("rejects when cumulative declared sizes exceed maxTotalBytes", async () => {
    const files = [fakeFile("plugin/a.bin", 60), fakeFile("plugin/b.bin", 60)];
    await expect(
      filesFromFolderSelection(files, {
        limits: { maxFileBytes: 80, maxTotalBytes: 100 },
      }),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_LARGE",
    });
    for (const file of files) {
      expect(file.arrayBuffer).not.toHaveBeenCalled();
    }
  });
});
