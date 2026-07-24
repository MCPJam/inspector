import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { parsePluginBundle, PluginBundleError } from "@mcpjam/sdk/plugin-bundle";
import {
  assertFolderWithinLimits,
  folderToZip,
  folderToZipBlob,
  PluginFolderTooLargeError,
} from "../folder-to-zip.js";
import {
  createFolderPluginSource,
  readBrowserFolderSelection,
  type PluginFolderFile,
  type PluginFolderFiles,
} from "../plugin-file-source.js";

const encoder = new TextEncoder();
const enc = (text: string): Uint8Array => encoder.encode(text);
const pathsOf = (files: PluginFolderFiles): string[] =>
  files.map((f) => f.path);

const MANIFEST = enc(
  JSON.stringify({
    name: "demo-plugin",
    version: "1.2.3",
    description: "A demo plugin for INS-1 parity tests.",
  }),
);

/** A valid combined bundle: manifest + one skill + a `.mcp.json` (mcp_servers). */
function combinedBundle(): PluginFolderFile[] {
  return [
    { path: ".codex-plugin/plugin.json", bytes: MANIFEST },
    {
      path: "skills/demo-skill/SKILL.md",
      bytes: enc(
        "---\nname: demo-skill\ndescription: Does demo things for tests.\n---\n\nInstructions.\n",
      ),
    },
    {
      path: ".mcp.json",
      bytes: enc(
        JSON.stringify({
          mcp_servers: {
            "local-server": {
              command: "node",
              args: ["${PLUGIN_ROOT}/server/index.js"],
              env: { DEMO_API_KEY: "${DEMO_API_KEY}" },
            },
          },
        }),
      ),
    },
  ];
}

describe("folderToZip", () => {
  it("produces a ZIP a standard unzipper can read back byte-for-byte", () => {
    const files = combinedBundle();
    const recovered = unzipSync(folderToZip(files));

    expect(Object.keys(recovered).sort()).toEqual(pathsOf(files).sort());
    for (const { path, bytes } of files) {
      // fflate may return a subarray view (differing byteOffset/buffer); compare
      // by content, not by typed-array identity/structure.
      expect(Array.from(recovered[path])).toEqual(Array.from(bytes));
    }
  });

  it("is deterministic for identical input", () => {
    expect(folderToZip(combinedBundle())).toEqual(
      folderToZip(combinedBundle()),
    );
  });

  it("wraps output as an application/zip Blob", () => {
    const blob = folderToZipBlob(combinedBundle());
    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("handles an empty folder (valid empty archive)", () => {
    expect(unzipSync(folderToZip([]))).toEqual({});
  });

  it("preflights against the DEFAULT SDK limits before materializing", () => {
    // A single file above the 10 MB default per-file cap must fail fast rather
    // than materialize the archive.
    const oversized = [
      { path: "big.bin", bytes: new Uint8Array(10 * 1024 * 1024 + 1) },
    ];
    expect(() => folderToZip(oversized)).toThrow(PluginFolderTooLargeError);
  });
});

describe("assertFolderWithinLimits", () => {
  const limits = {
    maxEntries: 2,
    maxTotalBytes: 50,
    maxFileBytes: 30,
    maxPathBytes: 512,
    maxPathDepth: 20,
    maxSkills: 20,
    maxMcpServers: 20,
  };

  it("rejects too many entries", () => {
    const files = [
      { path: "a", bytes: enc("x") },
      { path: "b", bytes: enc("y") },
      { path: "c", bytes: enc("z") },
    ];
    expect(() => assertFolderWithinLimits(files, limits)).toThrow(/files/);
  });

  it("rejects an oversized single file", () => {
    expect(() =>
      assertFolderWithinLimits(
        [{ path: "a", bytes: new Uint8Array(40) }],
        limits,
      ),
    ).toThrow(/per-file limit/);
  });

  it("rejects an oversized total", () => {
    expect(() =>
      assertFolderWithinLimits(
        [
          { path: "a", bytes: new Uint8Array(30) },
          { path: "b", bytes: new Uint8Array(30) },
        ],
        limits,
      ),
    ).toThrow(/uncompressed limit/);
  });

  it("accepts a folder within limits", () => {
    expect(() =>
      assertFolderWithinLimits([{ path: "a", bytes: enc("x") }], limits),
    ).not.toThrow();
  });
});

describe("folder vs ZIP bundle-hash parity", () => {
  // INS-1 acceptance: folder and ZIP sources produce the SAME bundle hash for
  // identical contents. The SDK bundle hash is content-addressed, so parsing a
  // folder source and parsing the same folder round-tripped through
  // folderToZip → unzip must yield the identical bundleHash.
  it("folder source and zipped-then-unzipped source hash identically", async () => {
    const files = combinedBundle();

    const fromFolder = await parsePluginBundle(createFolderPluginSource(files));

    const roundTripped = unzipSync(folderToZip(files));
    const rebuilt: PluginFolderFiles = Object.entries(roundTripped).map(
      ([path, bytes]) => ({ path, bytes }),
    );
    const fromZip = await parsePluginBundle(createFolderPluginSource(rebuilt));

    expect(fromFolder.bundleHash).toBe(fromZip.bundleHash);
    expect(fromFolder.manifestHash).toBe(fromZip.manifestHash);
    // Sanity: the bundle actually parsed its components (not an empty match).
    expect(fromFolder.skills).toHaveLength(1);
    expect(fromFolder.mcpServers).toHaveLength(1);
  });
});

describe("createFolderPluginSource — SDK path validators are not bypassed", () => {
  it("enforces maxBytes by throwing rather than truncating", async () => {
    const source = createFolderPluginSource([
      { path: "big.bin", bytes: new Uint8Array(100) },
    ]);
    await expect(source.readBytes("big.bin", 10)).rejects.toThrow(/exceeds/);
  });

  it("lists entries with sizes and reads text", async () => {
    const source = createFolderPluginSource([
      { path: "a.txt", bytes: enc("hello") },
    ]);
    expect(await source.list()).toEqual([
      { path: "a.txt", size: 5, kind: "file" },
    ]);
    expect(await source.readText?.("a.txt", 100)).toBe("hello");
  });

  it("surfaces an absolute path so the parser fires PATH_ABSOLUTE", async () => {
    const source = createFolderPluginSource([
      { path: ".codex-plugin/plugin.json", bytes: MANIFEST },
      { path: "/etc/passwd", bytes: enc("root:x:0:0") },
    ]);
    const err = await parsePluginBundle(source).catch((e) => e);
    expect(err).toBeInstanceOf(PluginBundleError);
    expect((err as PluginBundleError).issues.map((i) => i.code)).toContain(
      "PATH_ABSOLUTE",
    );
  });

  it("surfaces duplicate paths so the parser fires PATH_DUPLICATE", async () => {
    const source = createFolderPluginSource([
      { path: ".codex-plugin/plugin.json", bytes: MANIFEST },
      { path: "dup.txt", bytes: enc("a") },
      { path: "dup.txt", bytes: enc("b") },
    ]);
    const err = await parsePluginBundle(source).catch((e) => e);
    expect(err).toBeInstanceOf(PluginBundleError);
    expect((err as PluginBundleError).issues.map((i) => i.code)).toContain(
      "PATH_DUPLICATE",
    );
  });
});

describe("readBrowserFolderSelection", () => {
  // jsdom's File lacks arrayBuffer(); build a minimal browser-File-shaped stub
  // exposing exactly what readBrowserFolderSelection reads. An undefined
  // `relativePath` models a drag-and-drop file with no webkitRelativePath.
  function fakeFile(
    name: string,
    content: string,
    relativePath?: string,
  ): File {
    const bytes = enc(content);
    return {
      name,
      webkitRelativePath: relativePath ?? "",
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
  }

  it("strips the selected root directory segment so keys are bundle-relative", async () => {
    const files = await readBrowserFolderSelection([
      fakeFile("plugin.json", "{}", "my-plugin/.codex-plugin/plugin.json"),
      fakeFile("SKILL.md", "x", "my-plugin/skills/s/SKILL.md"),
    ]);
    expect(pathsOf(files).sort()).toEqual([
      ".codex-plugin/plugin.json",
      "skills/s/SKILL.md",
    ]);
  });

  it("falls back to file.name when webkitRelativePath is absent (drag-drop)", async () => {
    const files = await readBrowserFolderSelection([
      fakeFile("plugin.json", "{}"),
    ]);
    expect(pathsOf(files)).toEqual(["plugin.json"]);
    expect(files).toHaveLength(1);
  });
});
