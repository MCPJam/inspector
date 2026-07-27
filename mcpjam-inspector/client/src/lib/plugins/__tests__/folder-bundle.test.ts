import { describe, it, expect, beforeAll, vi } from "vitest";
import { webcrypto } from "node:crypto";
import {
  parsePluginBundle,
  type PluginFileEntry,
  type PluginFileSource,
} from "@mcpjam/sdk/plugin-bundle";
import {
  buildPluginZip,
  createFolderPluginFileSource,
  createMemoryPluginFileSource,
  createZipPluginFileSource,
  folderSelectionToPluginZip,
  parsePluginBundleFromFiles,
  parsePluginBundleFromFolderSelection,
  parsePluginBundleFromZip,
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

async function expectIssueCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    name: "PluginBundleError",
    code,
  });
}

// ---------------------------------------------------------------------------
// Raw ZIP fixture builder: zero-length STORED entries (CRC32 of empty = 0)
// with per-entry unix mode / encryption flags, so raw local/central/EOCD
// records — including ones jszip would sanitize or deduplicate — are fully
// under the test's control.
// ---------------------------------------------------------------------------

interface RawZipEntry {
  name: string;
  /** Unix mode word (type bits + permissions) for the central record. */
  mode?: number;
  /** Set the traditional-encryption general-purpose bit. */
  encrypted?: boolean;
}

function buildRawZip(
  entrySpecs: Array<string | RawZipEntry>,
  comment = "",
): Uint8Array {
  const specs = entrySpecs.map((spec) =>
    typeof spec === "string" ? { name: spec } : spec,
  );
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const spec of specs) {
    const nameBytes = encoder.encode(spec.name);
    const flags = spec.encrypted ? 0x1 : 0;
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, flags, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central directory signature
    // version made by: unix (3) when a mode is present so readers surface it.
    cv.setUint16(4, spec.mode !== undefined ? 0x031e : 20, true);
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, flags, true);
    cv.setUint16(28, nameBytes.length, true);
    if (spec.mode !== undefined) {
      cv.setUint32(38, (spec.mode & 0xffff) << 16, true); // external attrs
    }
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const commentBytes = encoder.encode(comment);
  const eocd = new Uint8Array(22 + commentBytes.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(8, specs.length, true); // entries on this disk
  ev.setUint16(10, specs.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  ev.setUint16(20, commentBytes.length, true);
  eocd.set(commentBytes, 22);

  const chunks = [...locals, ...centrals, eocd];
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    out.set(chunk, cursor);
    cursor += chunk.length;
  }
  return out;
}

/**
 * A `PluginFileSource` over literal entry FACTS (path/size/kind), used to
 * obtain the SDK parser's own verdict on the same raw facts the client zip
 * adapter surfaces — the parity oracle.
 */
function factSource(entries: PluginFileEntry[]): PluginFileSource {
  return {
    list: async () => entries,
    readBytes: async () => new Uint8Array(0),
  };
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
    const zipParsed = await parsePluginBundleFromZip(
      await buildPluginZip(files),
    );
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

  it("uploads built by buildPluginZip contain file records only", async () => {
    const zip = await buildPluginZip(files);
    const { default: JSZip } = await import("jszip");
    const loaded = await JSZip.loadAsync(zip);
    expect(
      Object.values(loaded.files).filter((entry) => entry.dir),
    ).toHaveLength(0);
  });
});

describe("createFolderPluginFileSource selection mapping", () => {
  function pickedFile(relativePath: string, content: string): File {
    const file = new File([content], relativePath.split("/").pop() ?? "");
    Object.defineProperty(file, "webkitRelativePath", {
      value: relativePath,
    });
    return file;
  }

  it("strips the shared picked-folder segment and filters OS junk", async () => {
    const source = createFolderPluginFileSource([
      pickedFile("my-plugin/.codex-plugin/plugin.json", "{}"),
      pickedFile("my-plugin/.mcp.json", "{}"),
      pickedFile("my-plugin/.DS_Store", "junk"),
      pickedFile("my-plugin/__MACOSX/resource", "junk"),
    ]);
    const entries = await source.list();
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      ".codex-plugin/plugin.json",
      ".mcp.json",
    ]);
  });

  it("keeps paths as-is when entries do not share a single root", async () => {
    const source = createFolderPluginFileSource([
      pickedFile("a/one.txt", "1"),
      pickedFile("b/two.txt", "2"),
    ]);
    const entries = await source.list();
    expect(entries.map((entry) => entry.path).sort()).toEqual([
      "a/one.txt",
      "b/two.txt",
    ]);
  });

  it("folderSelectionToPluginZip yields a zip whose parse matches the folder parse", async () => {
    const selection = [
      pickedFile(
        "my-plugin/.codex-plugin/plugin.json",
        JSON.stringify({ name: "demo-plugin" }),
      ),
      pickedFile(
        "my-plugin/.mcp.json",
        JSON.stringify({ mcp_servers: MCP_SERVERS }),
      ),
    ];
    const { parsed, zipBytes } = await folderSelectionToPluginZip(selection);
    const roundTripped = await parsePluginBundleFromZip(zipBytes);
    expect(roundTripped.bundleHash).toBe(parsed.bundleHash);
  });
});

describe("folder selection limits are SDK-enforced before any read", () => {
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
    await expectIssueCode(
      parsePluginBundleFromFolderSelection([big], {
        limits: { maxFileBytes: 1024 },
      }),
      "FILE_TOO_LARGE",
    );
    expect(big.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects too many files before reading any", async () => {
    const files = [fakeFile("plugin/a.txt", 1), fakeFile("plugin/b.txt", 1)];
    await expectIssueCode(
      parsePluginBundleFromFolderSelection(files, {
        limits: { maxEntries: 1 },
      }),
      "BUNDLE_TOO_MANY_ENTRIES",
    );
    for (const file of files) {
      expect(file.arrayBuffer).not.toHaveBeenCalled();
    }
  });

  it("rejects when cumulative declared sizes exceed maxTotalBytes", async () => {
    const files = [fakeFile("plugin/a.bin", 60), fakeFile("plugin/b.bin", 60)];
    await expectIssueCode(
      parsePluginBundleFromFolderSelection(files, {
        limits: { maxFileBytes: 80, maxTotalBytes: 100 },
      }),
      "BUNDLE_TOO_LARGE",
    );
    for (const file of files) {
      expect(file.arrayBuffer).not.toHaveBeenCalled();
    }
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

describe("client-only archive screen", () => {
  it("rejects >maxEntries raw records even when duplicate names would collapse", async () => {
    // 1001 records sharing one name: jszip's keyed `files` object would
    // deduplicate this to ONE compliant-looking entry, but the backend's
    // yauzl EOCD count sees 1001 — the raw count must reject it first.
    const zip = buildRawZip(Array.from({ length: 1001 }, () => "dup.txt"));
    await expect(createZipPluginFileSource(zip)).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_MANY_ENTRIES",
      message: expect.stringContaining("1001"),
    });
  });

  it("rejects duplicate names under the record limit as PATH_DUPLICATE", async () => {
    await expectIssueCode(
      createZipPluginFileSource(buildRawZip(["dup.txt", "dup.txt"])),
      "PATH_DUPLICATE",
    );
  });

  it("counts records correctly through an EOCD trailing comment", async () => {
    await expect(
      createZipPluginFileSource(
        buildRawZip(["a.txt", "b.txt", "c.txt"], "hello comment"),
        { limits: { maxEntries: 2 } },
      ),
    ).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_MANY_ENTRIES",
      message: expect.stringContaining("3"),
    });

    // ...and does not false-trigger on a compliant commented archive.
    const source = await createZipPluginFileSource(
      buildRawZip(["a.txt"], "hi"),
    );
    expect(await source.list()).toEqual([
      { path: "a.txt", size: 0, kind: "file" },
    ]);
  });

  it("rejects the ZIP64 0xFFFF total-entries sentinel", async () => {
    const eocd = new Uint8Array(22);
    const view = new DataView(eocd.buffer);
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, 0xffff, true);
    view.setUint16(10, 0xffff, true);
    await expect(createZipPluginFileSource(eocd)).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_MANY_ENTRIES",
      message: expect.stringContaining("ZIP64"),
    });
  });

  it("still screens archives with trailing bytes after the EOCD (jszip tolerates them)", async () => {
    const withTrailingJunk = (zip: Uint8Array, junk: number[]): Uint8Array => {
      const out = new Uint8Array(zip.length + junk.length);
      out.set(zip, 0);
      out.set(junk, zip.length);
      return out;
    };

    // An over-count bomb must still be rejected by the raw record count...
    const bomb = withTrailingJunk(
      buildRawZip(Array.from({ length: 1001 }, () => "dup.txt")),
      [0x00],
    );
    await expect(createZipPluginFileSource(bomb)).rejects.toMatchObject({
      name: "PluginBundleError",
      code: "BUNDLE_TOO_MANY_ENTRIES",
      message: expect.stringContaining("1001"),
    });

    // ...a duplicate pair must still be detected...
    await expectIssueCode(
      createZipPluginFileSource(
        withTrailingJunk(buildRawZip(["dup.txt", "dup.txt"]), [0x01, 0x02]),
      ),
      "PATH_DUPLICATE",
    );

    // ...and a clean junk-suffixed archive still parses with the same hash.
    const files = bundleFiles({ mcpServers: MCP_SERVERS });
    const clean = await parsePluginBundleFromFiles(files);
    const suffixed = await parsePluginBundleFromZip(
      withTrailingJunk(await buildPluginZip(files), [0xde, 0xad]),
    );
    expect(suffixed.bundleHash).toBe(clean.bundleHash);
  });

  it("rejects a configured maxEntries at or above the ZIP64 sentinel", async () => {
    await expect(
      createZipPluginFileSource(buildRawZip(["a.txt"]), {
        limits: { maxEntries: 0xffff },
      }),
    ).rejects.toThrow("below 65535");
  });

  it("aborts mid-stream when the declared size is forged below the cap", async () => {
    // 64 KiB of zeros, but the central directory claims 10 bytes — phase-1
    // validation passes (declared sizes look tiny), so only the bounded
    // stream can stop the actual inflation. The overrun surfaces through
    // the shared parser as FILE_UNREADABLE, same as the backend read path.
    const zip = await buildPluginZip([
      MANIFEST,
      { path: "big.bin", bytes: new Uint8Array(64 * 1024) },
    ]);
    const forged = forgeDeclaredSize(zip, "big.bin", 10);
    await expectIssueCode(parsePluginBundleFromZip(forged), "FILE_UNREADABLE");
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
});

// ---------------------------------------------------------------------------
// Table-driven preflight/authority parity: for each malicious-fixture family,
// the client verdict on the raw ZIP bytes must equal the SDK parser's verdict
// on the same raw entry facts (the shared-rulebook guarantee). Families the
// SDK cannot see (encryption, jszip name collapse, backslash names — archive
// concerns owned by the backend adapter) assert the documented client-only
// code instead.
// ---------------------------------------------------------------------------

describe("preflight parity with the SDK parser", () => {
  const S_IFLNK = 0o120000;

  const families: Array<{
    family: string;
    zip: () => Uint8Array | Promise<Uint8Array>;
    /** Raw entry facts the SDK oracle judges; omitted for client-only cases. */
    facts?: PluginFileEntry[];
    expectedCode: string;
  }> = [
    {
      family: "traversal entry name",
      zip: () => buildRawZip(["ok.txt", "../evil.txt"]),
      facts: [
        { path: "ok.txt", size: 0, kind: "file" },
        { path: "../evil.txt", size: 0, kind: "file" },
      ],
      expectedCode: "PATH_TRAVERSAL",
    },
    {
      family: "absolute entry name",
      zip: () => buildRawZip(["ok.txt", "/abs.txt"]),
      facts: [
        { path: "ok.txt", size: 0, kind: "file" },
        { path: "/abs.txt", size: 0, kind: "file" },
      ],
      expectedCode: "PATH_ABSOLUTE",
    },
    {
      family: "symlink record",
      zip: () =>
        buildRawZip(["ok.txt", { name: "link.txt", mode: S_IFLNK | 0o777 }]),
      facts: [
        { path: "ok.txt", size: 0, kind: "file" },
        { path: "link.txt", size: 0, kind: "symlink" },
      ],
      expectedCode: "PATH_LINK_ENTRY",
    },
    {
      family: "duplicate names",
      zip: () => buildRawZip(["dup.txt", "dup.txt"]),
      // jszip collapses the duplicate before the parser can see it, so the
      // client detects it structurally (EOCD count vs kept entries); the SDK
      // emits the SAME code for the same duplicate facts.
      facts: [
        { path: "dup.txt", size: 0, kind: "file" },
        { path: "dup.txt", size: 0, kind: "file" },
      ],
      expectedCode: "PATH_DUPLICATE",
    },
    {
      family: "too many records",
      zip: () =>
        buildRawZip(Array.from({ length: 1001 }, (_, i) => `f${i}.txt`)),
      facts: Array.from({ length: 1001 }, (_, i) => ({
        path: `f${i}.txt`,
        size: 0,
        kind: "file" as const,
      })),
      expectedCode: "BUNDLE_TOO_MANY_ENTRIES",
    },
    {
      family:
        "encrypted entry (archive-level; backend ARCHIVE_ENCRYPTED_ENTRY)",
      zip: () =>
        buildRawZip(["ok.txt", { name: "secret.txt", encrypted: true }]),
      expectedCode: "FILE_UNREADABLE",
    },
    {
      family: "backslash entry name (archive-level; yauzl rejects raw name)",
      zip: () => buildRawZip(["ok.txt", "a\\b.txt"]),
      expectedCode: "PATH_INVALID_CHARACTER",
    },
  ];

  for (const { family, zip, facts, expectedCode } of families) {
    it(`${family} → ${expectedCode}`, async () => {
      await expectIssueCode(
        (async () => parsePluginBundleFromZip(await zip()))(),
        expectedCode,
      );
      if (facts) {
        // The SDK parser's own verdict on the same raw facts — the oracle
        // the client adapter must agree with.
        await expectIssueCode(
          parsePluginBundle(factSource(facts)),
          expectedCode,
        );
      }
    });
  }

  it("clean bundle → accepted by both with the same bundle hash", async () => {
    const files = bundleFiles({ mcpServers: MCP_SERVERS });
    const viaSdkSource = await parsePluginBundleFromFiles(files);
    const viaZipAdapter = await parsePluginBundleFromZip(
      await buildPluginZip(files),
    );
    expect(viaZipAdapter.bundleHash).toBe(viaSdkSource.bundleHash);
    expect(viaZipAdapter.warnings).toEqual(viaSdkSource.warnings);
  });
});
