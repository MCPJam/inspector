import { describe, it, expect } from "vitest";
import { unzipSync } from "fflate";
import { parsePluginBundle } from "@mcpjam/sdk/plugin-bundle";
import { folderToZip, folderToZipBlob } from "../folder-to-zip.js";
import {
  createFolderPluginSource,
  readBrowserFolderSelection,
  type PluginFolderFiles,
} from "../plugin-file-source.js";

const encoder = new TextEncoder();
const enc = (text: string): Uint8Array => encoder.encode(text);

/** A valid combined bundle: manifest + one skill + a `.mcp.json` (mcp_servers). */
function combinedBundle(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    [
      ".codex-plugin/plugin.json",
      enc(
        JSON.stringify({
          name: "demo-plugin",
          version: "1.2.3",
          description: "A demo plugin for INS-1 parity tests.",
        }),
      ),
    ],
    [
      "skills/demo-skill/SKILL.md",
      enc(
        "---\nname: demo-skill\ndescription: Does demo things for tests.\n---\n\nInstructions.\n",
      ),
    ],
    [
      ".mcp.json",
      enc(
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
    ],
  ]);
}

describe("folderToZip", () => {
  it("produces a ZIP a standard unzipper can read back byte-for-byte", () => {
    const files = combinedBundle();
    const zip = folderToZip(files);
    const recovered = unzipSync(zip);

    expect(Object.keys(recovered).sort()).toEqual([...files.keys()].sort());
    for (const [path, bytes] of files) {
      // fflate may return a subarray view (differing byteOffset/buffer); compare
      // by content, not by typed-array identity/structure.
      expect(Array.from(recovered[path])).toEqual(Array.from(bytes));
    }
  });

  it("is deterministic for identical input", () => {
    const a = folderToZip(combinedBundle());
    const b = folderToZip(combinedBundle());
    expect(a).toEqual(b);
  });

  it("wraps output as an application/zip Blob", () => {
    const blob = folderToZipBlob(combinedBundle());
    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBeGreaterThan(0);
  });

  it("handles an empty folder (valid empty archive)", () => {
    const zip = folderToZip(new Map());
    expect(unzipSync(zip)).toEqual({});
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
    const rebuilt: PluginFolderFiles = new Map(Object.entries(roundTripped));
    const fromZip = await parsePluginBundle(createFolderPluginSource(rebuilt));

    expect(fromFolder.bundleHash).toBe(fromZip.bundleHash);
    expect(fromFolder.manifestHash).toBe(fromZip.manifestHash);
    // Sanity: the bundle actually parsed its components (not an empty match).
    expect(fromFolder.skills).toHaveLength(1);
    expect(fromFolder.mcpServers).toHaveLength(1);
  });
});

describe("createFolderPluginSource", () => {
  it("enforces maxBytes by throwing rather than truncating", async () => {
    const source = createFolderPluginSource(
      new Map([["big.bin", new Uint8Array(100)]]),
    );
    await expect(source.readBytes("big.bin", 10)).rejects.toThrow(/exceeds/);
  });

  it("lists entries with sizes and reads text", async () => {
    const source = createFolderPluginSource(
      new Map([["a.txt", enc("hello")]]),
    );
    const entries = await source.list();
    expect(entries).toEqual([{ path: "a.txt", size: 5, kind: "file" }]);
    expect(await source.readText?.("a.txt", 100)).toBe("hello");
  });
});

describe("readBrowserFolderSelection", () => {
  // jsdom's File lacks arrayBuffer(); build a minimal browser-File-shaped stub
  // exposing exactly what readBrowserFolderSelection reads.
  function fakeFile(relativePath: string, content: string): File {
    const bytes = enc(content);
    return {
      name: relativePath.split("/").pop() ?? "f",
      webkitRelativePath: relativePath,
      arrayBuffer: async () => bytes.buffer,
    } as unknown as File;
  }

  it("strips the selected root directory segment so keys are bundle-relative", async () => {
    const files = await readBrowserFolderSelection([
      fakeFile("my-plugin/.codex-plugin/plugin.json", "{}"),
      fakeFile("my-plugin/skills/s/SKILL.md", "x"),
    ]);
    expect([...files.keys()].sort()).toEqual([
      ".codex-plugin/plugin.json",
      "skills/s/SKILL.md",
    ]);
  });
});
