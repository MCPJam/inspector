/**
 * Execution metadata: which files are executable, the parser revision, and
 * the execution digest that keys a version's runnable identity.
 */

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_PARSER_REVISIONS,
  parsePluginBundle,
  type PluginFileEntry,
} from "../../src/plugin-bundle/index.js";
import {
  createDirectoryPluginFileSource,
  createZipPluginFileSource,
} from "../../src/plugin-bundle/node-file-sources.js";
import {
  bundle,
  encode,
  expectParseError,
  manifestJson,
  mcpJson,
} from "./fixtures.js";

const FILES: Record<string, string> = {
  "plugin.json": manifestJson(),
  "mcp.json": mcpJson({ local: { type: "stdio", command: "./bin/server" } }),
  "bin/server": "#!/bin/sh\necho server\n",
  "README.md": "# demo\n",
};
const MODES: Record<string, number> = {
  "plugin.json": 0o644,
  "mcp.json": 0o644,
  "bin/server": 0o755,
  "README.md": 0o644,
};

/** An in-memory source reporting the given modes, as an adapter would. */
function withModes(modes: Record<string, number | undefined>) {
  const entries: PluginFileEntry[] = Object.entries(FILES).map(
    ([path, content]) => ({
      path,
      size: encode(content).byteLength,
      ...(modes[path] !== undefined ? { mode: modes[path] } : {}),
    })
  );
  return bundle(FILES, { entries });
}

async function zipWithModes(options: {
  date?: Date;
  level?: number;
}): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(FILES)) {
    zip.file(path, content, {
      unixPermissions: MODES[path],
      date: options.date ?? new Date("2026-01-01T00:00:00Z"),
    });
  }
  return zip.generateAsync({
    type: "uint8array",
    platform: "UNIX",
    compression: "DEFLATE",
    compressionOptions: { level: options.level ?? 6 },
  });
}

describe("executable files", () => {
  it.each([
    // A POSIX `zip -y` link: file-type bits 0o120000, target as content.
    ["a link", 0o120777],
    ["a FIFO", 0o010755],
  ])(
    "rejects a ZIP entry typed as %s instead of listing it as an executable file",
    async (_label, unixPermissions) => {
      const zip = new JSZip();
      for (const [path, content] of Object.entries(FILES)) {
        zip.file(path, content, { unixPermissions: MODES[path] });
      }
      zip.file("bin/link", "server", { unixPermissions });
      const bytes = await zip.generateAsync({
        type: "uint8array",
        platform: "UNIX",
      });
      await expectParseError(
        await createZipPluginFileSource(bytes),
        "PATH_LINK_ENTRY"
      );
    }
  );

  it("treats a ZIP file with a regular-file type as a file", async () => {
    const zip = new JSZip();
    for (const [path, content] of Object.entries(FILES)) {
      zip.file(path, content, { unixPermissions: 0o100000 | MODES[path] });
    }
    const parsed = await parsePluginBundle(
      await createZipPluginFileSource(
        await zip.generateAsync({ type: "uint8array", platform: "UNIX" })
      )
    );
    expect(parsed.executableFiles).toEqual(["bin/server"]);
  });

  it.each([
    ["setuid", 0o4755],
    ["setgid", 0o2755],
    ["sticky", 0o1755],
  ])(
    "keeps a %s executable executable, and nothing else about its mode",
    async (_, mode) => {
      const plain = await parsePluginBundle(withModes(MODES));
      const special = await parsePluginBundle(
        withModes({ ...MODES, "bin/server": mode, "README.md": 0o4644 })
      );
      expect(special.executableFiles).toEqual(["bin/server"]);
      expect(special.executionDigest).toBe(plain.executionDigest);
    }
  );

  it.each([
    ["setuid", 0o4000],
    ["setgid", 0o2000],
    ["sticky", 0o1000],
  ])("does not take a lone %s bit for an executable one", async (_, mode) => {
    const parsed = await parsePluginBundle(
      withModes({ ...MODES, "bin/server": mode })
    );
    expect(parsed.executableFiles).toEqual([]);
  });

  it("has no executable files when the source reports no modes", async () => {
    const parsed = await parsePluginBundle(bundle(FILES));
    expect(parsed.executableFiles).toEqual([]);
  });
});

describe("execution digest", () => {
  it("is identical across the in-memory, directory and ZIP sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-exec-"));
    try {
      for (const [path, content] of Object.entries(FILES)) {
        const absolute = join(root, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
        await chmod(absolute, MODES[path]);
      }
      const fromMemory = await parsePluginBundle(withModes(MODES));
      const fromDirectory = await parsePluginBundle(
        createDirectoryPluginFileSource(root)
      );
      const fromZip = await parsePluginBundle(
        await createZipPluginFileSource(await zipWithModes({}))
      );
      expect(fromDirectory.executableFiles).toEqual(["bin/server"]);
      expect(fromZip.executableFiles).toEqual(["bin/server"]);
      expect(fromDirectory.executionDigest).toBe(fromMemory.executionDigest);
      expect(fromZip.executionDigest).toBe(fromMemory.executionDigest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ignores ZIP timestamps and compression", async () => {
    const a = await parsePluginBundle(
      await createZipPluginFileSource(await zipWithModes({ level: 1 }))
    );
    const b = await parsePluginBundle(
      await createZipPluginFileSource(
        await zipWithModes({ level: 9, date: new Date("2030-06-01T00:00:00Z") })
      )
    );
    expect(b.executionDigest).toBe(a.executionDigest);
  });

  it("changes with the executable bits while the content hash does not", async () => {
    const executable = await parsePluginBundle(withModes(MODES));
    const plain = await parsePluginBundle(
      withModes({ ...MODES, "bin/server": 0o644 })
    );
    expect(plain.bundleHash).toBe(executable.bundleHash);
    expect(plain.executionDigest).not.toBe(executable.executionDigest);
  });

  it("records the revision of the profile that read the bundle", async () => {
    const strict = await parsePluginBundle(bundle(FILES));
    const compat = await parsePluginBundle(bundle(FILES), {
      profile: "openai-compatible",
    });
    expect(strict.interpretation.revision).toBe(PLUGIN_PARSER_REVISIONS.strict);
    expect(compat.interpretation.revision).toBe(
      PLUGIN_PARSER_REVISIONS["openai-compatible"]
    );
    expect(compat.executionDigest).not.toBe(strict.executionDigest);
    expect(Object.isFrozen(PLUGIN_PARSER_REVISIONS)).toBe(true);
  });
});
