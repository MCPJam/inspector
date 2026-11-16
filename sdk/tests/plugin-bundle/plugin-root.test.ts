/**
 * Where the plugin root is, and which names a manifest may declare, as the
 * ChatGPT portal states them (`openai-compatible`), against Agent Plugins 1.0
 * (`strict`, unchanged).
 *
 * Before this change the import parser refused a package zipped as one
 * folder (`MANIFEST_MISSING`) and a name with an uppercase letter or `_`,
 * both of which the portal accepts. The messages here are copied from the
 * portal's submission-errors page, so a test fails if the parser's wording
 * drifts from the portal's.
 */

import { describe, expect, it } from "vitest";
import {
  parsePluginBundle,
  type PluginFileEntry,
} from "../../src/plugin-bundle/index.js";
import {
  SAMPLE_PLUGIN_FOLDER,
  SAMPLE_PLUGIN_NAME,
  SAMPLE_SERVER_URL,
  samplePackageFiles,
  siblingSamplePackageFiles,
  wrapIn,
  wrappedSamplePackageFiles,
} from "./chatgpt-package-fixtures.js";
import { bundle, expectParseError, manifestJson } from "./fixtures.js";

const compat = { profile: "openai-compatible" } as const;
const codes = (warnings: { code: string }[]) => warnings.map((w) => w.code);

const PORTAL = {
  manifestMissing:
    "ZIP must contain root `plugin.json` with a supported Agent Plugins schema, `.codex-plugin/plugin.json`, `.agent-plugin/plugin.json`, or `.claude-plugin/plugin.json` at the root or in its single top-level directory.",
  rootAmbiguous:
    "ZIP must contain exactly one plugin root, either at the archive root or in one top-level directory.",
  rootHasSiblings:
    "A ZIP with a top-level plugin directory must not contain sibling files.",
  nameWrongType: "`name` must be a string.",
  nameTooLong: "`name` must be 64 characters or fewer.",
  nameFormat:
    "`name` must start with an ASCII letter or digit and contain only ASCII letters, digits, `_`, or `-`.",
};

describe("the sample ChatGPT package at the archive root", () => {
  it("imports as it did before: Agent Plugins layout, two skills, one remote server", async () => {
    const parsed = await parsePluginBundle(
      bundle(samplePackageFiles()),
      compat
    );
    expect(parsed.interpretation).toEqual({
      profile: "openai-compatible",
      revision: 1,
      layout: "agent-plugins",
      manifestPath: "plugin.json",
    });
    expect(parsed.manifest.name).toBe(SAMPLE_PLUGIN_NAME);
    expect(parsed.skills.map((skill) => skill.name)).toEqual([
      "find-notes",
      "summarize-notes",
    ]);
    expect(parsed.mcpServers.map((server) => server.config)).toEqual([
      expect.objectContaining({
        transport: "http",
        httpVariant: "streamable-http",
        url: SAMPLE_SERVER_URL,
      }),
    ]);
    // The same single warning the real package had: no dark directory icon.
    expect(codes(parsed.warnings)).toEqual([
      "MANIFEST_DIRECTORY_ICON_VARIANT_MISSING",
    ]);
    const openai = parsed.manifest.extensions["com.openai"] as {
      review: { test_cases: { positive: unknown[]; negative: unknown[] } };
      publication: unknown;
    };
    expect(openai.review.test_cases.positive).toHaveLength(5);
    expect(openai.review.test_cases.negative).toHaveLength(3);
    expect(openai.publication).toEqual({ release_notes: "Initial release." });
  });
});

describe("one wrapping top-level folder", () => {
  it("imports the wrapped package with the same identity as the unwrapped one", async () => {
    const root = await parsePluginBundle(bundle(samplePackageFiles()), compat);
    const wrapped = await parsePluginBundle(
      bundle(wrappedSamplePackageFiles()),
      compat
    );
    expect(wrapped.interpretation).toEqual({
      ...root.interpretation,
      rootDirectory: SAMPLE_PLUGIN_FOLDER,
    });
    // Paths are relative to the plugin root, so the content hashes agree.
    expect(wrapped.bundleHash).toBe(root.bundleHash);
    expect(wrapped.manifestHash).toBe(root.manifestHash);
    expect(wrapped.executionDigest).toBe(root.executionDigest);
    expect(wrapped.skills).toEqual(root.skills);
    expect(wrapped.mcpServers).toEqual(root.mcpServers);
    expect(wrapped.assets).toEqual(root.assets);
    expect(wrapped.warnings).toEqual(root.warnings);
  });

  it("reads each file from its path in the archive", async () => {
    const source = bundle(wrappedSamplePackageFiles());
    await parsePluginBundle(source, compat);
    expect(source.reads).toContain(`${SAMPLE_PLUGIN_FOLDER}/plugin.json`);
    expect(source.reads).not.toContain("plugin.json");
  });

  it("ignores the folder's own directory entry", async () => {
    const files = wrappedSamplePackageFiles();
    const entries: PluginFileEntry[] = [
      { path: `${SAMPLE_PLUGIN_FOLDER}/`, size: 0, kind: "directory" },
      ...Object.entries(files).map(([path, content]) => ({
        path,
        size: new TextEncoder().encode(content).byteLength,
      })),
    ];
    const parsed = await parsePluginBundle(bundle(files, { entries }), compat);
    expect(parsed.interpretation.rootDirectory).toBe(SAMPLE_PLUGIN_FOLDER);
  });

  it("finds a legacy manifest inside the folder", async () => {
    const parsed = await parsePluginBundle(
      bundle(
        wrapIn("db-tools", {
          ".claude-plugin/plugin.json": JSON.stringify({ name: "db-tools" }),
          "skills/query/SKILL.md":
            "---\nname: query\ndescription: Query the database.\n---\n\nRun queries.\n",
        })
      ),
      compat
    );
    expect(parsed.interpretation).toMatchObject({
      layout: "claude",
      manifestPath: ".claude-plugin/plugin.json",
      rootDirectory: "db-tools",
    });
    expect(parsed.skills.map((skill) => skill.name)).toEqual(["query"]);
  });

  it("refuses a file beside the folder, in the portal's words, before reading content", async () => {
    const source = bundle(siblingSamplePackageFiles());
    const error = await expectParseError(
      source,
      "PLUGIN_ROOT_HAS_SIBLINGS",
      compat
    );
    expect(error.issues).toEqual([
      {
        code: "PLUGIN_ROOT_HAS_SIBLINGS",
        severity: "error",
        message: PORTAL.rootHasSiblings,
        path: "README.md",
      },
    ]);
    expect(source.reads).toEqual([]);
  });

  it("counts operating-system metadata beside the folder as a sibling", async () => {
    // The portal's rule names no exception for `__MACOSX/` or `.DS_Store`.
    const error = await expectParseError(
      bundle({
        ...wrappedSamplePackageFiles(),
        [`__MACOSX/${SAMPLE_PLUGIN_FOLDER}/._plugin.json`]: "metadata",
      }),
      "PLUGIN_ROOT_HAS_SIBLINGS",
      compat
    );
    expect(error.issues.map((issue) => issue.path)).toEqual(["__MACOSX"]);
  });

  it("refuses two folders that each hold a manifest", async () => {
    const error = await expectParseError(
      bundle({
        "first/plugin.json": manifestJson({ name: "first" }),
        "second/.codex-plugin/plugin.json": JSON.stringify({ name: "second" }),
      }),
      "PLUGIN_ROOT_AMBIGUOUS",
      compat
    );
    expect(
      error.issues.map(({ code, message, path }) => ({ code, message, path }))
    ).toEqual([
      {
        code: "PLUGIN_ROOT_AMBIGUOUS",
        message: PORTAL.rootAmbiguous,
        path: "first",
      },
      {
        code: "PLUGIN_ROOT_AMBIGUOUS",
        message: PORTAL.rootAmbiguous,
        path: "second",
      },
    ]);
  });

  it("keeps a manifest at the archive root authoritative over a folder's", async () => {
    const parsed = await parsePluginBundle(
      bundle({
        "plugin.json": manifestJson(),
        "vendored/plugin.json": manifestJson({ name: "vendored" }),
      }),
      compat
    );
    expect(parsed.manifest.name).toBe("demo-plugin");
    expect(parsed.interpretation.rootDirectory).toBeUndefined();
  });

  it("states the portal's rule when no manifest is found", async () => {
    const error = await expectParseError(
      bundle(wrapIn("docs", { "README.md": "# hi" })),
      "MANIFEST_MISSING",
      compat
    );
    expect(error.issues.map((issue) => issue.message)).toEqual([
      PORTAL.manifestMissing,
    ]);
  });

  it("stays Agent Plugins 1.0 under strict: the manifest is only at the root", async () => {
    await expectParseError(
      bundle(wrappedSamplePackageFiles()),
      "MANIFEST_MISSING"
    );
  });
});

describe("plugin names", () => {
  for (const name of ["Sample_Notes", "SampleNotes", "sample_notes", "a-"]) {
    it(`imports ${JSON.stringify(name)}, which the portal accepts`, async () => {
      const parsed = await parsePluginBundle(
        bundle(samplePackageFiles({ name })),
        compat
      );
      expect(parsed.manifest.name).toBe(name);
    });
  }

  it("still imports a dotted name, which imported before", async () => {
    const parsed = await parsePluginBundle(
      bundle(samplePackageFiles({ name: "com.example.notes" })),
      compat
    );
    expect(parsed.manifest.name).toBe("com.example.notes");
  });

  for (const [name, message] of [
    ["sample notes", PORTAL.nameFormat],
    ["-sample", PORTAL.nameFormat],
    ["a".repeat(65), PORTAL.nameTooLong],
    [7, PORTAL.nameWrongType],
  ] as const) {
    it(`refuses ${JSON.stringify(name)} in the portal's words`, async () => {
      const error = await expectParseError(
        bundle(samplePackageFiles({ name })),
        "MANIFEST_INVALID_NAME",
        compat
      );
      expect(
        error.issues.find((issue) => issue.code === "MANIFEST_INVALID_NAME")
          ?.message
      ).toBe(message);
    });
  }

  it("keeps Agent Plugins' rule under strict", async () => {
    await expectParseError(
      bundle(samplePackageFiles({ name: "Sample_Notes" })),
      "MANIFEST_INVALID_NAME"
    );
  });
});
