/**
 * The readiness reader finds the plugin where the import parser does.
 *
 * Before this change the reader looked for a manifest only in `.codex-plugin/`,
 * `.agent-plugin/` and `.claude-plugin/`, so the Agent Plugins layout (root
 * `plugin.json` and `mcp.json`, which OpenAI recommends and which MCPJam's own
 * accepted submission used) graded as `manifest-missing`, and so did any
 * package zipped as one folder. It also checked no `name` rule but a length of
 * 100. Refusals now carry the portal's own codes and messages, copied here from
 * its submission-errors page.
 */

import { describe, expect, it } from "vitest";

import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import { runOpenAIMigrationChecks } from "../../src/openai-readiness/checks/migration.js";
import { runOpenAIPackageChecks } from "../../src/openai-readiness/checks/package.js";
import { readOpenAIPluginPackage } from "../../src/openai-readiness/package/reader.js";
import { xmldomParseXml } from "../../src/openai-readiness/package/svg-xml-node.js";
import {
  SAMPLE_PLUGIN_FOLDER,
  SAMPLE_PLUGIN_NAME,
  samplePackageFiles,
  siblingSamplePackageFiles,
  wrappedSamplePackageFiles,
} from "../plugin-bundle/chatgpt-package-fixtures.js";
import { InMemoryOpenAIPackageSource } from "./package-fixtures.js";

const read = (files: Record<string, string | Uint8Array>) =>
  readOpenAIPluginPackage(new InMemoryOpenAIPackageSource(files), {
    parseXml: xmldomParseXml,
  });

const codes = (evidence: { issues: { id: string }[] }): string[] =>
  evidence.issues.map((issue) => issue.id);

const STAMP = { evaluatedAt: "2026-11-13T00:00:00.000Z" };

const PORTAL = {
  manifestMissing:
    "ZIP must contain root `plugin.json` with a supported Agent Plugins schema, `.codex-plugin/plugin.json`, `.agent-plugin/plugin.json`, or `.claude-plugin/plugin.json` at the root or in its single top-level directory.",
  rootAmbiguous:
    "ZIP must contain exactly one plugin root, either at the archive root or in one top-level directory.",
  rootHasSiblings:
    "A ZIP with a top-level plugin directory must not contain sibling files.",
  nameFormat:
    "`name` must start with an ASCII letter or digit and contain only ASCII letters, digits, `_`, or `-`.",
};

describe("the Agent Plugins layout", () => {
  it("reads the sample package's manifest, servers and skills with no portal issue", async () => {
    const evidence = await read(samplePackageFiles());
    expect(codes(evidence)).toEqual([]);
    expect(evidence.rootDirectory).toBeUndefined();
    expect(evidence.manifest).toMatchObject({
      location: { path: "plugin.json", canonical: true },
      name: SAMPLE_PLUGIN_NAME,
      version: "1.0.0",
      // From the root `mcp.json`, where the layout declares its servers.
      mcpServerNames: [SAMPLE_PLUGIN_NAME],
    });
    expect(evidence.manifest?.location.normalizedFrom).toBeUndefined();
    expect(evidence.skills.map((skill) => skill.directory)).toEqual([
      "skills/find-notes",
      "skills/summarize-notes",
    ]);
  });

  it("grades the package lane clean for an MCP submission with uploaded skills", async () => {
    const findings = runOpenAIPackageChecks(
      {
        mode: "mcp-uploaded-skills",
        package: await read(samplePackageFiles()),
      },
      STAMP
    );
    for (const id of [
      "openai.package.archive",
      "openai.package.manifest",
      "openai.package.skills",
      "openai.package.assets",
      "openai.package.exclusions",
    ]) {
      expect(findings.find((finding) => finding.id === id)?.status, id).toBe(
        "satisfied"
      );
    }
  });

  it("treats a root plugin.json without an Agent Plugins schema as no manifest", async () => {
    const files = samplePackageFiles();
    const manifest = JSON.parse(files["plugin.json"]);
    delete manifest.$schema;
    const evidence = await read({
      ...files,
      "plugin.json": JSON.stringify(manifest),
    });
    expect(evidence.issues).toContainEqual(
      expect.objectContaining({
        id: "plugin_manifest_missing",
        message: PORTAL.manifestMissing,
        subject: "plugin.json",
      })
    );
  });

  it("scans mcp.json, so a stdio server there is not a pass", async () => {
    const findings = runOpenAIMigrationChecks(
      await read({
        ...samplePackageFiles(),
        "mcp.json": JSON.stringify({
          mcpServers: { local: { type: "stdio", command: "node" } },
        }),
      }),
      STAMP
    );
    expect(
      findings.find(
        (finding) => finding.id === "openai.migration.stdio-transport"
      )?.status
    ).toBe("violated");
  });

  it("scans mcp.json for a ${user_config.*} placeholder", async () => {
    const findings = runOpenAIMigrationChecks(
      await read({
        ...samplePackageFiles(),
        "mcp.json": JSON.stringify({
          mcpServers: {
            remote: {
              type: "streamable-http",
              url: "https://mcp.example.com/mcp",
              headers: { Authorization: "Bearer ${user_config.api_key}" },
            },
          },
        }),
      }),
      STAMP
    );
    expect(
      findings.find((finding) => finding.id === "openai.migration.user-config")
        ?.status
    ).toBe("violated");
  });
});

describe("one wrapping top-level folder", () => {
  it("reads the wrapped package exactly as the unwrapped one", async () => {
    const root = await read(samplePackageFiles());
    const wrapped = await read(wrappedSamplePackageFiles());
    expect(codes(wrapped)).toEqual([]);
    expect(wrapped.rootDirectory).toBe(SAMPLE_PLUGIN_FOLDER);
    expect(wrapped.manifest).toEqual(root.manifest);
    expect(wrapped.skills).toEqual(root.skills);
    expect(wrapped.assets).toEqual(root.assets);
  });

  it("refuses a file beside the folder in the portal's words, and grades the plugin anyway", async () => {
    const evidence = await read(siblingSamplePackageFiles());
    expect(evidence.issues).toEqual([
      expect.objectContaining({
        id: "plugin_root_has_siblings",
        category: "package-archive",
        severity: "blocking",
        message: PORTAL.rootHasSiblings,
        subject: "README.md",
      }),
    ]);
    expect(evidence.manifest?.name).toBe(SAMPLE_PLUGIN_NAME);
    expect(evidence.skills).toHaveLength(2);
  });

  it("refuses two folders that each hold a manifest", async () => {
    const evidence = await read({
      "first/.codex-plugin/plugin.json": JSON.stringify({ name: "first" }),
      "second/.codex-plugin/plugin.json": JSON.stringify({ name: "second" }),
    });
    expect(
      evidence.issues.map(({ id, message, subject }) => ({
        id,
        message,
        subject,
      }))
    ).toEqual([
      {
        id: "plugin_root_ambiguous",
        message: PORTAL.rootAmbiguous,
        subject: "first",
      },
      {
        id: "plugin_root_ambiguous",
        message: PORTAL.rootAmbiguous,
        subject: "second",
      },
    ]);
    expect(evidence.manifest).toBeUndefined();
  });

  it("reports a package with no manifest in the portal's words", async () => {
    const evidence = await read({ "notes/README.md": "# notes" });
    expect(evidence.issues).toEqual([
      expect.objectContaining({
        id: "plugin_manifest_missing",
        category: "package-manifest",
        message: PORTAL.manifestMissing,
      }),
    ]);
  });
});

describe("the portal's name rules", () => {
  const nameIssues = async (name: unknown) => {
    const evidence = await read(samplePackageFiles({ name }));
    return evidence.issues.filter((issue) => issue.id.includes("name"));
  };

  it("accepts the names the portal accepts", async () => {
    for (const name of [SAMPLE_PLUGIN_NAME, "Sample_Notes", "a-"]) {
      expect(await nameIssues(name), name).toEqual([]);
    }
  });

  it("refuses a dotted name, which the portal does not accept", async () => {
    expect(await nameIssues("com.example.notes")).toEqual([
      expect.objectContaining({
        id: "plugin_name_format",
        message: PORTAL.nameFormat,
        subject: "plugin.json",
        observed: "com.example.notes",
      }),
    ]);
  });

  it("caps a name at the portal's 64 characters, not 100", async () => {
    expect((await nameIssues("a".repeat(65))).map((issue) => issue.id)).toEqual(
      ["plugin_name_too_long"]
    );
  });

  it("names a missing, empty or non-string name by the portal's codes", async () => {
    expect((await nameIssues(undefined)).map((issue) => issue.id)).toEqual([
      "plugin_name_missing",
    ]);
    expect((await nameIssues("  ")).map((issue) => issue.id)).toEqual([
      "plugin_name_empty",
    ]);
    expect((await nameIssues(7)).map((issue) => issue.id)).toEqual([
      "plugin_name_wrong_type",
    ]);
  });
});

describe("one implementation", () => {
  for (const [label, files] of [
    ["at the archive root", samplePackageFiles()],
    ["wrapped in one folder", wrappedSamplePackageFiles()],
    [
      "in the Codex layout",
      {
        ".codex-plugin/plugin.json": JSON.stringify({ name: "sample" }),
        "skills/find-notes/SKILL.md":
          "---\nname: find-notes\ndescription: Find notes.\n---\n\nFind them.\n",
      },
    ],
  ] as const) {
    it(`finds the same root and manifest as the import parser, ${label}`, async () => {
      const parsed = await parsePluginBundle(
        new InMemoryOpenAIPackageSource(files),
        { profile: "openai-compatible" }
      );
      const evidence = await read(files);
      expect(evidence.rootDirectory).toBe(parsed.interpretation.rootDirectory);
      expect(evidence.manifest?.location.path).toBe(
        parsed.interpretation.manifestPath
      );
      expect(evidence.skills.map((skill) => skill.skillFilePath)).toEqual(
        parsed.skills.map((skill) => skill.skillFilePath)
      );
    });
  }
});
