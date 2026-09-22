/**
 * Agent Plugins 1.0 client conformance suite.
 *
 * One named test per load/parse-time MUST from the client-implementers
 * checklist (https://agent-plugins.org/client-implementers/conformance,
 * with the underlying requirements from /loading-and-discovery and
 * /mcp-runtime). The describe blocks mirror the checklist's sections —
 * Plugin Loader, Discovery and Isolation, MCP Support, Versioning — so this
 * file reads as the checklist itself.
 *
 * Several requirements are exercised in more depth by the sibling suites
 * (manifest.test.ts, mcp-config.test.ts, paths.test.ts,
 * parse-plugin-bundle.test.ts); the re-assertions here are deliberately thin
 * so every checklist item has exactly one obvious home.
 *
 * Runtime-only MUSTs the parser cannot assert (spawn behavior, placeholder
 * expansion at launch, `PLUGIN_DATA` persistence, remote header/origin
 * handling) and MCPJam's documented deviations are catalogued in
 * ../../src/plugin-bundle/CONFORMANCE.md.
 */

import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_MANIFEST_SCHEMAS,
  PLUGIN_MCP_SCHEMAS,
  parsePluginBundle,
} from "../../src/plugin-bundle/index.js";
// Internal normalizer, imported directly (not on the public barrel) so the
// version-match rule can be exercised: through `parsePluginBundle` a version
// mismatch is unrepresentable today because both compiled-in allowlists hold
// only 1.0.0.
import { normalizePluginMcpConfig } from "../../src/plugin-bundle/mcp-config.js";
import { PluginIssueCollector } from "../../src/plugin-bundle/validation.js";
import {
  MCP_SCHEMA_URL,
  bundle,
  expectParseError,
  manifestJson,
  mcpJson,
  minimalBundle,
  skillMd,
} from "./fixtures.js";

function withMcp(servers: Record<string, unknown>) {
  return minimalBundle({ "mcp.json": mcpJson(servers) });
}

describe("conformance: Plugin Loader", () => {
  it("MUST enforce the package boundary: a traversal entry rejects the bundle before any content is read", async () => {
    const source = bundle({
      "plugin.json": manifestJson(),
      "../outside.txt": "escape",
    });
    await expectParseError(source, "PATH_TRAVERSAL");
    expect(source.reads).toEqual([]);
  });

  it("MUST enforce the package boundary: absolute entry paths are rejected", async () => {
    await expectParseError(
      bundle({ "plugin.json": manifestJson(), "/etc/passwd": "boom" }),
      "PATH_ABSOLUTE"
    );
  });

  it("MUST enforce the boundary after resolving links — MCPJam rejects link entries outright (documented deviation)", async () => {
    await expectParseError(
      bundle(
        { "plugin.json": manifestJson() },
        {
          entries: [
            { path: "plugin.json", size: manifestJson().length },
            { path: "innocent-looking.md", size: 0, kind: "symlink" },
          ],
        }
      ),
      "PATH_LINK_ENTRY"
    );
  });

  it("MUST select locally supported manifest rules from $schema", async () => {
    const parsed = await parsePluginBundle(minimalBundle());
    // The version comes from the compiled-in identifier map, not the network.
    expect(parsed.schemaVersion).toBe("1.0.0");
    expect(PLUGIN_MANIFEST_SCHEMAS["1.0.0"]).toBe(
      "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
    );
  });

  it("MUST NOT retrieve a schema while loading a plugin", async () => {
    const fetchSpy = vi.fn(() => {
      throw new Error("network access attempted during plugin load");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      // Accepting a supported schema and rejecting an unsupported one must
      // both complete without a single network request.
      await parsePluginBundle(minimalBundle());
      await parsePluginBundle(
        minimalBundle(
          {},
          {
            $schema:
              "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
          }
        )
      ).catch(() => undefined);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("MUST reject a plugin whose manifest is missing $schema", async () => {
    await expectParseError(
      minimalBundle({}, { $schema: undefined }),
      "MANIFEST_UNSUPPORTED_SCHEMA"
    );
  });

  it("MUST reject an unsupported $schema with a clear error naming the identifier", async () => {
    const error = await expectParseError(
      minimalBundle(
        {},
        {
          $schema: "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json",
        }
      ),
      "MANIFEST_UNSUPPORTED_SCHEMA"
    );
    expect(error.message).toContain(
      "https://agent-plugins.org/schemas/9.0.0/plugin.schema.json"
    );
  });

  it("MUST require the name field", async () => {
    await expectParseError(
      minimalBundle({}, { name: undefined }),
      "MANIFEST_INVALID_NAME"
    );
  });

  it.each([
    "a",
    "demo-plugin",
    "com.example.deploy",
    "deploy.tools-2",
    "0plugin",
    // The canonical pattern excludes only same-character doubles ("--",
    // ".."); mixed adjacent separators are spec-VALID names.
    "foo.-bar",
    "foo-.bar",
  ])(
    "MUST accept spec-valid name %j (dots legal, mixed separators legal)",
    async (name) => {
      const parsed = await parsePluginBundle(minimalBundle({}, { name }));
      expect(parsed.manifest.name).toBe(name);
    }
  );

  it.each([
    "Demo",
    "demo_plugin",
    "demo plugin",
    "-demo",
    "demo-",
    ".demo",
    "demo.",
    "demo--plugin",
    "demo..plugin",
    "",
  ])("MUST reject name %j outside the canonical pattern", async (name) => {
    await expectParseError(
      minimalBundle({}, { name }),
      "MANIFEST_INVALID_NAME"
    );
  });

  it("MUST treat version as a free-form string (no imposed format)", async () => {
    for (const version of ["latest", "2024.1", "v1.2.3-beta+build.7"]) {
      const parsed = await parsePluginBundle(minimalBundle({}, { version }));
      expect(parsed.manifest.version).toBe(version);
    }
  });

  it("MUST report and ignore unknown top-level manifest fields (closed object, non-fatal)", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { future_field: { nested: true } })
    );
    expect(parsed.manifest.name).toBe("demo-plugin");
    expect(
      parsed.warnings.some((issue) => issue.code === "MANIFEST_UNKNOWN_FIELD")
    ).toBe(true);
  });

  it("MUST report and ignore a non-object extensions field (non-fatal)", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({}, { extensions: "not-an-object" })
    );
    expect(parsed.manifest.extensions).toEqual({});
    expect(
      parsed.warnings.some((issue) => issue.code === "MANIFEST_INVALID_FIELD")
    ).toBe(true);
  });

  it("MUST apply implemented extension namespaces and ignore all others without validating their values", async () => {
    const foreign = {
      config: { mode: "fast", retries: 3, flags: [true, null, "x"] },
    };
    const parsed = await parsePluginBundle(
      minimalBundle(
        {},
        {
          extensions: {
            "com.mcpjam": { display_name: "Demo Plugin" },
            "com.example.other": foreign,
          },
        }
      )
    );
    // Implemented namespace applied...
    expect(parsed.manifest.displayName).toBe("Demo Plugin");
    // ...unimplemented namespace round-trips unvalidated (its shape imposed
    // no requirements). Secret-looking keys/values WOULD be screened out —
    // a documented deviation (see CONFORMANCE.md).
    expect(parsed.manifest.extensions["com.example.other"]).toEqual(foreign);
  });

  it("MUST reject fatal manifest violations before component discovery", async () => {
    const error = await expectParseError(
      minimalBundle(
        { "skills/good-skill/SKILL.md": skillMd("good-skill") },
        { name: "Bad Name" }
      ),
      "MANIFEST_INVALID_NAME"
    );
    // The rejection happened before skills were discovered: no skill-level
    // issue was ever produced.
    expect(error.issues.some((issue) => issue.code.startsWith("SKILL_"))).toBe(
      false
    );
  });
});

describe("conformance: Discovery and Isolation", () => {
  it("MUST locate the manifest only at the fixed root location — nested plugin.json files are ordinary files", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "vendored/plugin.json": JSON.stringify({ name: "other" }),
      })
    );
    expect(parsed.manifest.name).toBe("demo-plugin");

    // A manifest that exists only outside the fixed location is missing.
    await expectParseError(
      bundle({ "nested/plugin.json": manifestJson() }),
      "MANIFEST_MISSING"
    );
  });

  it("MUST discover MCP configuration only from the root mcp.json", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({ "vendored/mcp.json": mcpJson({}) })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_CONFIG_IGNORED")
    ).toBe(true);
  });

  it("MUST discover skills only as immediate child directories of skills/ containing SKILL.md", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/group/nested/SKILL.md": skillMd("nested"),
      })
    );
    // Not at the fixed depth ⇒ not a skill, not an error — just a file.
    expect(parsed.skills).toEqual([]);
    expect(parsed.skipped).toEqual([]);
  });

  it("MUST treat missing component locations as valid absence", async () => {
    const parsed = await parsePluginBundle(minimalBundle());
    expect(parsed.skills).toEqual([]);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("MUST skip one non-conforming skill and continue loading its siblings", async () => {
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
  });

  it("MUST isolate an invalid mcp.json document to disabling the MCP component type only", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/good-skill/SKILL.md": skillMd("good-skill"),
        "mcp.json": "{ not json",
      })
    );
    // The bundle survives, skills survive; only MCP is disabled.
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "mcp-config", key: "mcp.json" }),
    ]);
  });

  it("MUST skip one invalid MCP entry without disabling valid siblings", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        good: { type: "streamable-http", url: "https://ok.example.com/mcp" },
        bad: { type: "carrier-pigeon", url: "https://bad.example.com/mcp" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["good"]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "server", key: "bad" }),
    ]);
  });

  it("MUST surface each skip as a typed component skip with its issues demoted to warnings", async () => {
    const parsed = await parsePluginBundle(withMcp({ bad: { type: "stdio" } }));
    expect(parsed.skipped).toEqual([
      {
        kind: "server",
        key: "bad",
        reason: expect.stringContaining("command"),
      },
    ]);
    // Nothing about a skipped component may remain error-severity: the parse
    // succeeded and every issue is reportable on `warnings`.
    expect(
      parsed.warnings.some((issue) => issue.code === "COMPONENT_SKIPPED")
    ).toBe(true);
    expect(parsed.warnings.every((issue) => issue.severity === "warning")).toBe(
      true
    );
  });

  it("MUST ignore unsupported component types without marking a plugin error", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "hooks/on_start.sh": "#!/bin/sh\necho hi",
        "com.example.vendor/extra.json": "{}",
      })
    );
    expect(parsed.skipped).toEqual([]);
    expect(parsed.warnings).toEqual([]);
  });

  it("MUST support at least one of skills or MCP servers (MCPJam implements both)", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "skills/good-skill/SKILL.md": skillMd("good-skill"),
        "mcp.json": mcpJson({
          crm: { type: "streamable-http", url: "https://crm.example.com/mcp" },
        }),
      })
    );
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.mcpServers).toHaveLength(1);
  });
});

describe("conformance: MCP Support", () => {
  it("MUST support stdio and Streamable HTTP, and MAY support legacy SSE — all three declared types load", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        local: { type: "stdio", command: "node" },
        modern: { type: "streamable-http", url: "https://a.example.com/mcp" },
        legacy: { type: "sse", url: "https://b.example.com/sse" },
      })
    );
    expect(parsed.mcpServers).toHaveLength(3);
    expect(parsed.skipped).toEqual([]);
  });

  it("MUST use the declared type as authoritative — an entry with a url but no type is never inferred", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        "no-type": { url: "https://would-infer.example.com/mcp" },
      })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "server", key: "no-type" }),
    ]);
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_UNKNOWN_TRANSPORT")
    ).toBe(true);
  });

  it("MUST make an unknown transport type invalidate only that entry", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        ok: { type: "stdio", command: "node" },
        ws: { type: "websocket", url: "https://ws.example.com" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["ok"]);
    expect(parsed.skipped.map((skip) => skip.key)).toEqual(["ws"]);
  });

  it("MUST NOT fold alternate type spellings on the strict plugin path — the schema consts are exact", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        folded: {
          type: "streamable_http",
          url: "https://folded.example.com/mcp",
        },
      })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped.map((skip) => skip.key)).toEqual(["folded"]);
  });

  it("MUST record the declared sse transport for the initial connection attempt (not folded to streamable-http)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({ legacy: { type: "sse", url: "https://b.example.com/sse" } })
    );
    expect(parsed.mcpServers[0].config).toMatchObject({
      transport: "http",
      httpVariant: "sse",
    });
  });

  it("MUST validate the closed top-level document — an unknown field disables MCP for the plugin", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "mcp.json": JSON.stringify({
          $schema: MCP_SCHEMA_URL,
          mcpServers: {},
          telemetry: true,
        }),
      })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "mcp-config", key: "mcp.json" }),
    ]);
  });

  it("MUST require the mcpServers object", async () => {
    const parsed = await parsePluginBundle(
      minimalBundle({
        "mcp.json": JSON.stringify({ $schema: MCP_SCHEMA_URL }),
      })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(parsed.skipped).toEqual([
      expect.objectContaining({ kind: "mcp-config" }),
    ]);
  });

  it("MUST validate each server entry independently against the closed entry schema", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        ok: { type: "stdio", command: "node" },
        extra: {
          type: "streamable-http",
          url: "https://extra.example.com/mcp",
          unknown_field: true,
        },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["ok"]);
    expect(parsed.skipped.map((skip) => skip.key)).toEqual(["extra"]);
    expect(
      parsed.warnings.some((issue) => issue.code === "MCP_UNKNOWN_FIELD")
    ).toBe(true);
  });

  it("MUST treat command as one executable token with args passed separately — never shell-split", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        local: {
          type: "stdio",
          command: "node --enable-source-maps",
          args: ["server.js", "--verbose"],
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      // Preserved verbatim as ONE token (the runtime resolves it as a single
      // executable name); args stay a separate array.
      expect(config.command).toBe("node --enable-source-maps");
      expect(config.args).toEqual(["server.js", "--verbose"]);
    }
  });

  it.each(["PLUGIN_ROOT", "PLUGIN_DATA"])(
    "MUST keep %s client-controlled — an env block defining it invalidates the entry",
    async (reserved) => {
      const parsed = await parsePluginBundle(
        withMcp({
          bad: {
            type: "stdio",
            command: "node",
            env: { [reserved]: "/tmp/evil" },
          },
        })
      );
      expect(parsed.mcpServers).toEqual([]);
      expect(parsed.skipped.map((skip) => skip.key)).toEqual(["bad"]);
      expect(
        parsed.warnings.some((issue) => issue.code === "MCP_RESERVED_ENV_KEY")
      ).toBe(true);
    }
  );

  it.each(["${PLUGIN_ROOT}/bin/server", "${PLUGIN_DATA}/bin/server"])(
    "MUST expand plugin variables only in args, env values, and cwd — command %j rejects the entry",
    async (command) => {
      const parsed = await parsePluginBundle(
        withMcp({ bad: { type: "stdio", command } })
      );
      expect(parsed.mcpServers).toEqual([]);
      expect(
        parsed.warnings.some(
          (issue) => issue.code === "MCP_PLACEHOLDER_IN_COMMAND"
        )
      ).toBe(true);
    }
  );

  it("MUST preserve the two placeholders verbatim in args, env values, and cwd — parse time never expands", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        local: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/server/index.js", "${PLUGIN_DATA}/cache"],
          env: { DATA_DIR: "${PLUGIN_DATA}/data" },
          cwd: "${PLUGIN_ROOT}/srv",
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    expect(config.transport).toBe("stdio");
    if (config.transport === "stdio") {
      expect(config.args).toEqual([
        "${PLUGIN_ROOT}/server/index.js",
        "${PLUGIN_DATA}/cache",
      ]);
      expect(config.envRequirements).toContainEqual({
        name: "DATA_DIR",
        required: false,
        valueTemplate: "${PLUGIN_DATA}/data",
      });
      expect(config.workingDirectory).toBe("${PLUGIN_ROOT}/srv");
    }
  });

  it("MUST expand only the two defined placeholders — ${OTHER_VAR} is not a plugin variable in cwd", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        bad: { type: "stdio", command: "node", cwd: "${OTHER_VAR}/x" },
      })
    );
    expect(parsed.mcpServers).toEqual([]);
    expect(
      parsed.warnings.some(
        (issue) => issue.code === "MCP_INVALID_WORKING_DIRECTORY"
      )
    ).toBe(true);
  });

  it("MUST resolve './' commands against the plugin root — the stored form routes through the verified bundle path", async () => {
    const parsed = await parsePluginBundle(
      withMcp({ local: { type: "stdio", command: "./bin/server" } })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "stdio") {
      expect(config.command).toBe("${PLUGIN_ROOT}/bin/server");
    }
  });

  it("MUST enforce containment for './' commands — an escaping command invalidates only that entry", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        bad: { type: "stdio", command: "./bin/../../outside" },
        ok: { type: "stdio", command: "./bin/server" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["ok"]);
    expect(
      parsed.warnings.some((issue) => issue.code === "PATH_ESCAPES_ROOT")
    ).toBe(true);
  });

  it("MUST enforce working-directory containment — an escaping cwd invalidates only that entry", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        bad: { type: "stdio", command: "node", cwd: "./a/../../out" },
        ok: { type: "stdio", command: "node", cwd: "./" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key)).toEqual(["ok"]);
    expect(
      parsed.warnings.some((issue) => issue.code === "PATH_ESCAPES_ROOT")
    ).toBe(true);
  });

  it("MUST validate remote URLs before connecting — MCPJam requires HTTPS for non-loopback (documented policy)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        insecure: { type: "streamable-http", url: "http://mcp.example.com" },
        loopback: { type: "streamable-http", url: "http://localhost:3100/mcp" },
        ok: { type: "streamable-http", url: "https://ok.example.com/mcp" },
      })
    );
    expect(parsed.mcpServers.map((server) => server.key).sort()).toEqual([
      "loopback",
      "ok",
    ]);
    expect(
      parsed.warnings.some(
        (issue) => issue.code === "MCP_INSECURE_URL_LOCALHOST"
      )
    ).toBe(true);
  });

  it("MUST validate literal headers before connecting — secret-looking literals are never stored (documented deviation)", async () => {
    const parsed = await parsePluginBundle(
      withMcp({
        api: {
          type: "streamable-http",
          url: "https://api.example.com/mcp",
          headers: { "X-Custom": "Bearer sk-live-conformance" },
        },
      })
    );
    const config = parsed.mcpServers[0].config;
    if (config.transport === "http") {
      expect(config.headerRequirements).toEqual([
        { name: "X-Custom", secret: true },
      ]);
    }
    expect(JSON.stringify(parsed)).not.toContain("sk-live-conformance");
  });
});

describe("conformance: Versioning", () => {
  it("MUST require matching Agent Plugins versions in plugin.json and mcp.json", () => {
    const issues = new PluginIssueCollector();
    const result = normalizePluginMcpConfig(JSON.parse(mcpJson({})), {
      sourcePath: "mcp.json",
      // mcp.json resolves to 1.0.0; the manifest targets a different version.
      manifestSchemaVersion: "0.9.0",
      issues,
    });
    expect(result.documentVersion).toBeNull();
    expect(result.servers).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        kind: "mcp-config",
        reason: expect.stringContaining("versions must match"),
      }),
    ]);
  });

  it("MUST never reassign a published canonical schema identifier — the compiled-in maps are frozen and exact", () => {
    expect(Object.isFrozen(PLUGIN_MANIFEST_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(PLUGIN_MCP_SCHEMAS)).toBe(true);
    expect(PLUGIN_MANIFEST_SCHEMAS).toEqual({
      "1.0.0": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    });
    expect(PLUGIN_MCP_SCHEMAS).toEqual({
      "1.0.0": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    });
  });

  it("MAY apply a local compatibility policy for older versions — MCPJam supports exactly Agent Plugins 1.0.0", () => {
    expect(Object.keys(PLUGIN_MANIFEST_SCHEMAS)).toEqual(["1.0.0"]);
    expect(Object.keys(PLUGIN_MCP_SCHEMAS)).toEqual(["1.0.0"]);
  });
});
