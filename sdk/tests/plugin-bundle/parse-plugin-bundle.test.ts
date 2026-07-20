/**
 * End-to-end fixture bundles from the plan: minimal, skill-only, MCP-only,
 * combined, app-plus-skills, supporting files, and unsupported components.
 */

import { describe, expect, it } from "vitest";
import { parsePluginBundle } from "../../src/plugin-bundle/index.js";
import {
  MCP_JSON_DIRECT,
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
    expect(parsed.skills).toEqual([]);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.apps).toEqual([]);
    expect(parsed.assets).toEqual([]);
    expect(parsed.unsupported).toEqual([]);
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

  it("parses an MCP-only bundle", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ ".mcp.json": MCP_JSON_DIRECT })
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
        ".mcp.json": MCP_JSON_STDIO,
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
        ".mcp.json": MCP_JSON_DIRECT,
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
        ".mcp.json": MCP_JSON_DIRECT,
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

  it("captures agents/openai.yaml metadata without executing anything", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/demo-skill/SKILL.md": SKILL_MD,
        "skills/demo-skill/agents/openai.yaml": [
          "allow_implicit_invocation: true",
          "mcp_tools:",
          "  - demo-server/list_items",
          "  - demo-server/create_item",
        ].join("\n"),
      })
    );
    const skill = parsed.skills[0];
    expect(skill.allowImplicitInvocation).toBe(true);
    expect(skill.mcpToolDependencies).toEqual([
      "demo-server/list_items",
      "demo-server/create_item",
    ]);
    expect(skill.openaiMetadata?.path).toBe(
      "skills/demo-skill/agents/openai.yaml"
    );
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

  it("rejects two skills declaring the same name", async () => {
    await expectParseError(
      minimalBundle({
        "skills/one/SKILL.md": skillMd("same-name"),
        "skills/two/SKILL.md": skillMd("same-name"),
      }),
      "SKILL_DUPLICATE_NAME"
    );
  });

  it("enforces the max skill count", async () => {
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

  it.each([
    [
      "missing frontmatter",
      "No frontmatter here.",
      "SKILL_FRONTMATTER_MISSING",
    ],
    [
      "missing description",
      "---\nname: demo-skill\n---\nBody",
      "SKILL_MISSING_DESCRIPTION",
    ],
    [
      "invalid name",
      "---\nname: Bad_Name\ndescription: x\n---\nBody",
      "SKILL_INVALID_NAME",
    ],
    [
      "over-long description",
      `---\nname: demo-skill\ndescription: ${"d".repeat(1100)}\n---\nBody`,
      "SKILL_DESCRIPTION_TOO_LONG",
    ],
  ] as const)("rejects a skill with %s", async (_label, content, code) => {
    await expectParseError(
      minimalBundle({ "skills/demo-skill/SKILL.md": content }),
      code
    );
  });

  it("preserves hooks directories as unsupported components", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "hooks/on_start.sh": "#!/bin/sh\necho hi",
        "tasks/daily.json": JSON.stringify({ cron: "0 0 * * *" }),
      })
    );
    expect(parsed.unsupported).toEqual([
      expect.objectContaining({
        kind: "hooks",
        key: "hooks",
        paths: ["hooks/on_start.sh"],
      }),
      expect.objectContaining({
        kind: "scheduled-task",
        key: "tasks",
        paths: ["tasks/daily.json"],
      }),
    ]);
    expect(
      parsed.warnings.filter((issue) => issue.code === "UNSUPPORTED_COMPONENT")
    ).toHaveLength(2);
  });

  it("ignores non-root .mcp.json files with a warning", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "nested/.mcp.json": MCP_JSON_DIRECT })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "MCP_CONFIG_IGNORED" }),
    ]);
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
        ".codex-plugin/plugin.json": manifestJson({
          version: "not-semver",
          homepage: "http://insecure.example",
        }),
      }),
      "MANIFEST_INVALID_VERSION"
    );
    const codes = error.issues.map((issue) => issue.code);
    expect(codes).toContain("MANIFEST_INSECURE_URL");
  });
});
