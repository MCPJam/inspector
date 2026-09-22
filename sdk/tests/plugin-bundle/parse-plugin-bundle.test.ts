/**
 * End-to-end Agent Plugins bundle fixtures: minimal, skill-only, MCP-only,
 * combined, app-plus-skills, supporting files, and failure isolation.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import {
  MCP_JSON_HTTP,
  MCP_JSON_STDIO,
  SKILL_MD,
  bundle,
  expectParseError,
  manifestJson,
  minimalBundle,
  skillMd,
} from "./fixtures.js";

describe("parsePluginBundle fixtures", () => {
  it("parses a minimal manifest-only bundle", async () => {
    const parsed = await parsePluginBundle(minimalBundle());
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(parsed.skills).toEqual([]);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.apps).toEqual([]);
    expect(parsed.assets).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.setupRequirements).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("parses a skill-only bundle with namespaced model refs", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "skills/demo-skill/SKILL.md": SKILL_MD })
    );
    expect(parsed.skills).toHaveLength(1);
    const skill = parsed.skills[0];
    expect(skill).toMatchObject({
      componentKey: "skill:demo-skill",
      directory: "skills/demo-skill",
      name: "demo-skill",
      description: "Does demo things for tests.",
      modelRef: "demo-plugin/demo-skill",
      instructions: "Use this skill to demo the parser.",
      mcpToolDependencies: [],
      supportingFiles: [],
    });
    expect(skill.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(skill.aggregateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.warnings).toEqual([]);
  });

  it("namespaces model refs under dotted plugin names", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle(
        { "skills/demo-skill/SKILL.md": SKILL_MD },
        { name: "com.example.deploy" }
      )
    );
    expect(parsed.skills[0].modelRef).toBe("com.example.deploy/demo-skill");
  });

  it("parses an MCP-only bundle", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "mcp.json": MCP_JSON_HTTP })
    );
    expect(parsed.skills).toEqual([]);
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0].key).toBe("demo-server");
    expect(parsed.setupRequirements).toEqual([
      {
        kind: "header",
        componentKey: "server:demo-server",
        serverKey: "demo-server",
        name: "Authorization",
        secret: true,
      },
    ]);
  });

  it("parses a combined skill-plus-MCP bundle", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/demo-skill/SKILL.md": SKILL_MD,
        "mcp.json": MCP_JSON_STDIO,
      })
    );
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.mcpServers).toHaveLength(1);
    expect(parsed.mcpServers[0].config.transport).toBe("stdio");
    expect(parsed.setupRequirements).toEqual([
      {
        kind: "env",
        componentKey: "server:local-server",
        serverKey: "local-server",
        name: "DEMO_API_KEY",
        required: true,
      },
    ]);
  });

  it("parses app-plus-skills bundles and binds declared servers", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/demo-skill/SKILL.md": SKILL_MD,
        "mcp.json": MCP_JSON_HTTP,
        "todo.app.json": JSON.stringify({
          app_id: "com.example.todo",
          server: "demo-server",
          display_name: "Todo",
        }),
      })
    );
    expect(parsed.apps).toEqual([
      expect.objectContaining({
        componentKey: "app:todo.app.json",
        appId: "com.example.todo",
        serverKey: "demo-server",
        binding: "declared",
        status: "bound",
        extensions: { display_name: "Todo" },
      }),
    ]);
  });

  it("infers the app binding when the bundle has exactly one server", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "mcp.json": MCP_JSON_HTTP,
        ".app.json": JSON.stringify({ id: "com.example.solo" }),
      })
    );
    expect(parsed.apps[0]).toMatchObject({
      appId: "com.example.solo",
      serverKey: "demo-server",
      binding: "inferred",
      status: "bound",
    });
  });

  it("marks apps referencing unknown servers as needs_server_binding", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        ".app.json": JSON.stringify({
          app_id: "com.example.orphan",
          server: "not-in-bundle",
        }),
      })
    );
    expect(parsed.apps[0]).toMatchObject({
      binding: "unbound",
      status: "needs_server_binding",
    });
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "APP_UNKNOWN_SERVER" }),
    ]);
  });

  it("collects skill supporting files with hashes and relative paths", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/demo-skill/SKILL.md": SKILL_MD,
        "skills/demo-skill/references/guide.md": "# Guide",
        "skills/demo-skill/scripts/run.py": "print('hi')",
      })
    );
    const skill = parsed.skills[0];
    expect(
      skill.supportingFiles.map((file) => file.relativePath).sort()
    ).toEqual(["references/guide.md", "scripts/run.py"]);
    for (const file of skill.supportingFiles) {
      expect(file.path.startsWith("skills/demo-skill/")).toBe(true);
      expect(file.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("reads skill metadata from frontmatter without executing anything", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/demo-skill/SKILL.md": [
          "---",
          "name: demo-skill",
          "description: Does demo things for tests.",
          "allow_implicit_invocation: true",
          "mcp_tools:",
          "  - demo-server/list_items",
          "  - demo-server/create_item",
          "---",
          "",
          "Body.",
        ].join("\n"),
      })
    );
    const skill = parsed.skills[0];
    expect(skill.allowImplicitInvocation).toBe(true);
    expect(skill.mcpToolDependencies).toEqual([
      "demo-server/list_items",
      "demo-server/create_item",
    ]);
  });

  it("warns when the skill name does not match its directory", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "skills/other-dir/SKILL.md": SKILL_MD })
    );
    expect(parsed.skills[0].name).toBe("demo-skill");
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "SKILL_NAME_MISMATCH" }),
    ]);
  });

  it("enforces the max skill count as a bundle error", async () => {
    await expectParseError(
      minimalBundle({
        "skills/skill-a/SKILL.md": skillMd("skill-a"),
        "skills/skill-b/SKILL.md": skillMd("skill-b"),
        "skills/skill-c/SKILL.md": skillMd("skill-c"),
      }),
      "SKILL_TOO_MANY",
      { limits: { maxSkills: 2 } }
    );
  });

  it("classifies screenshots under assets/", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "assets/screenshots/main.txt": "placeholder" })
    );
    expect(parsed.assets).toEqual([
      expect.objectContaining({
        path: "assets/screenshots/main.txt",
        kind: "screenshot",
        contentType: "text/plain",
      }),
    ]);
  });

  it("treats unknown top-level directories as plain files, not components", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "hooks/on_start.sh": "#!/bin/sh\necho hi",
        "com.example.vendor/extra.json": "{}",
      })
    );
    expect(parsed.skills).toEqual([]);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.apps).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("does not treat skill supporting .app.json files as app components", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/demo-skill/SKILL.md": SKILL_MD,
        "skills/demo-skill/example.app.json": JSON.stringify({ id: "x" }),
      })
    );
    expect(parsed.apps).toEqual([]);
    expect(parsed.skills[0].supportingFiles).toHaveLength(1);
  });

  it("reports every collected issue on the thrown error", async () => {
    const error = await expectParseError(
      bundle({
        "plugin.json": manifestJson({
          version: 42,
          homepage: "http://insecure.example",
        }),
      }),
      "MANIFEST_INVALID_VERSION"
    );
    const codes = error.issues.map((issue) => issue.code);
    expect(codes).toContain("MANIFEST_INSECURE_URL");
  });
});

describe("skill failure isolation", () => {
  it("skips one invalid skill, keeping valid siblings", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/good-skill/SKILL.md": skillMd("good-skill"),
        "skills/bad-skill/SKILL.md": "No frontmatter here.",
      })
    );
    expect(parsed.skills.map((skill) => skill.name)).toEqual(["good-skill"]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "skill", key: "bad-skill" }),
    ]);
    expect(
      parsed.warnings.some(
        (issue) => issue.code === "SKILL_FRONTMATTER_MISSING"
      )
    ).toBe(true);
    expect(
      parsed.warnings.some((issue) => issue.code === "COMPONENT_SKIPPED")
    ).toBe(true);
  });

  it.each([
    ["missing description", "---\nname: demo-skill\n---\nBody"],
    ["invalid name", "---\nname: Bad_Name\ndescription: x\n---\nBody"],
    [
      "over-long description",
      `---\nname: demo-skill\ndescription: ${"d".repeat(1100)}\n---\nBody`,
    ],
  ] as const)("skips a skill with %s, never the bundle", async (_label, content) => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "skills/demo-skill/SKILL.md": content })
    );
    expect(parsed.skills).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "skill", key: "demo-skill" }),
    ]);
  });

  it("skips the second of two skills declaring the same name", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/one/SKILL.md": skillMd("same-name"),
        "skills/two/SKILL.md": skillMd("same-name"),
      })
    );
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "skill", key: "two" }),
    ]);
    expect(
      parsed.warnings.some((issue) => issue.code === "SKILL_DUPLICATE_NAME")
    ).toBe(true);
  });
});

describe("hostile nesting", () => {
  it("isolates a deep [[[...]]] frontmatter bomb to a skill skip, not a RangeError", async () => {
    const bomb = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    const content = `---\nname: demo-skill\ndescription: x\nextra: ${bomb}\n---\nBody`;
    const parsed = await parsePluginBundle(
      minimalBundle({ "skills/demo-skill/SKILL.md": content })
    );
    expect(parsed.skills).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "skill", key: "demo-skill" }),
    ]);
    expect(
      parsed.warnings.some((issue) => issue.code === "VALUE_TOO_DEEP")
    ).toBe(true);
  });
});
