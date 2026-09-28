/**
 * The adapter's contract with the framework and with MCPJam's own machinery.
 *
 * These are the assertions that fail LOUDLY here rather than quietly inside a
 * sandbox: the capability declarations `HarnessAgent` enforces at construction,
 * the lifecycle `data` shape `harness-session-state.ts` reaches into, the
 * bootstrap's credential-independence, and the agreement between the builtin
 * catalog and the names the translator actually emits.
 */
import { describe, expect, it } from "vitest";
import { harnessV1StreamPartSchema } from "@ai-sdk/harness";
import { asSchema } from "ai";
import {
  CODEX_APPSERVER_BUILTIN_TOOLS,
  CODEX_APPSERVER_NATIVE_TOOL_NAMES,
  CODEX_APPSERVER_TOOL_NAMES,
  codexAppServerResumeStateSchema,
  createCodexAppServer,
  getCodexAppServerBootstrap,
} from "../index.js";
import { toCodexPermissions } from "../bridge/index.js";

describe("harness declaration", () => {
  const harness = createCodexAppServer();

  it("declares the framework-required identity", () => {
    expect(harness.specificationVersion).toBe("harness-v1");
    // The SAME harness id as the exec transport: one Codex host, two
    // transports. A different id would fork every session lane and split the
    // product's Codex history in two.
    expect(harness.harnessId).toBe("codex");
  });

  it("declares built-in tool approvals, which is the point of the transport", () => {
    // `HarnessAgent` THROWS at construction if a non-`allow-all` permission
    // mode is requested from a harness that does not declare this. The exec
    // adapter declares false, which is exactly why an approval-gated Codex host
    // is unrepresentable today.
    expect(harness.supportsBuiltinToolApprovals).toBe(true);
  });

  it("does not claim tool filtering it cannot do", () => {
    expect(harness.supportsBuiltinToolFiltering).toBe(false);
  });

  it("publishes a lifecycle schema the session machinery can read", () => {
    expect(harness.lifecycleStateSchema).toBe(codexAppServerResumeStateSchema);
  });
});

describe("builtin tool catalog", () => {
  it("covers exactly the names the translator emits", () => {
    // The catalog keys are literals (a computed key erases the literal type
    // `satisfies` needs), so this is the guard against the two drifting.
    expect(Object.keys(CODEX_APPSERVER_BUILTIN_TOOLS).sort()).toEqual(
      Object.values(CODEX_APPSERVER_TOOL_NAMES).sort(),
    );
  });

  it("carries the native names MEASURED against the pinned CLI", () => {
    // `exec_command`, not `shell`. codex app-server 0.149.1 declares a
    // PTY-backed unified exec taking `{cmd: string}`; the `shell` name belongs
    // to the exec transport. Copying that catalog would put a tool on the trace
    // that never runs. See `.spike-codex-appserver/RESULTS.md`.
    expect(CODEX_APPSERVER_NATIVE_TOOL_NAMES.commandExecution).toBe(
      "exec_command",
    );
    const tools = CODEX_APPSERVER_BUILTIN_TOOLS as Record<
      string,
      { nativeName?: string; commonName?: string; toolUseKind?: string }
    >;
    expect(tools.bash?.nativeName).toBe("exec_command");
    expect(tools.bash?.commonName).toBe("bash");
    expect(tools.webSearch?.nativeName).toBe("web_search");
    expect(tools.fileChange?.nativeName).toBe("apply_patch");
    // No common equivalent: Claude Code reports edits as Write/Edit calls,
    // Codex reports one patch covering every path.
    expect(tools.fileChange?.commonName).toBeUndefined();
    expect(tools.fileChange?.toolUseKind).toBe("edit");
  });

  it("exposes input schemas the display catalogue can convert", () => {
    // `listBuiltinTools` in the registry runs each schema through `asSchema`.
    // A schema that cannot convert silently loses its parameters in the UI.
    for (const [name, tool] of Object.entries(CODEX_APPSERVER_BUILTIN_TOOLS)) {
      const jsonSchema = asSchema(
        (tool as { inputSchema: Parameters<typeof asSchema>[0] }).inputSchema,
      ).jsonSchema;
      expect(jsonSchema, `${name} input schema`).toMatchObject({
        type: "object",
      });
    }
  });
});

describe("permission mapping", () => {
  it("gates side effects under an approval mode and frees them otherwise", () => {
    // `untrusted` is what produces approval requests: Codex auto-approves the
    // commands it knows are read-only and asks about the rest.
    expect(toCodexPermissions("allow-reads")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    // `allow-edits` maps the same way ON PURPOSE: Codex has no middle policy
    // that gates writes but not reads, and when the host asked for approval the
    // safe direction is to ask more, not less.
    expect(toCodexPermissions("allow-edits")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    expect(toCodexPermissions("allow-all")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    // An unset mode is the permissive default, matching the framework's own.
    expect(toCodexPermissions(undefined)).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
  });
});

describe("lifecycle state", () => {
  it("keeps the bridge shape the inspector's session machinery reads", () => {
    // `harness-session-state.ts` reaches into
    // `resumeState.data.bridge.sandboxId` to notice a replaced box. A rename
    // here degrades that check to its legacy path SILENTLY.
    const parsed = codexAppServerResumeStateSchema.parse({
      threadId: "thr_1",
      turnConfigurationFingerprint: "abc123",
      bridge: {
        port: 41234,
        token: "t",
        lastSeenEventId: 12,
        sandboxId: "sbx_1",
      },
      sandboxCredentialEnvironment: { CODEX_API_KEY: "placeholder" },
    });
    expect(parsed.bridge?.sandboxId).toBe("sbx_1");
  });

  it("accepts a payload with no bridge (the stop case)", () => {
    expect(
      codexAppServerResumeStateSchema.parse({ threadId: "thr_1" }).bridge,
    ).toBeUndefined();
  });

  it("does not carry framework-owned continuation state", () => {
    // Pending approvals, pending tool results and turn settings are the
    // framework's to persist. A second copy in adapter `data` is the one that
    // goes stale.
    const shape = Object.keys(codexAppServerResumeStateSchema.shape);
    expect(shape).not.toContain("pendingToolApprovals");
    expect(shape).not.toContain("pendingToolResults");
    expect(shape).not.toContain("turnSettings");
  });
});

describe("bootstrap", () => {
  it("is byte-identical regardless of credentials", () => {
    // The framework hashes the recipe into the bootstrap identity, and
    // `registry.test.ts` asserts this for every adapter. It is why the model
    // proxy's URL is rendered by the bridge at session start rather than
    // written into a bootstrap file.
    const first = JSON.stringify(getCodexAppServerBootstrap());
    const second = JSON.stringify(getCodexAppServerBootstrap());
    expect(first).toBe(second);
    expect(first).not.toContain("CODEX_API_KEY=");
    expect(first).not.toMatch(/https?:\/\/[^"]*proxy/i);
  });

  it("ships both entrypoints and pins the codex version exactly", () => {
    const bootstrap = getCodexAppServerBootstrap();
    const paths = bootstrap.files.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/package.json"),
        expect.stringContaining("/bridge.mjs"),
        // Codex spawns this one itself; nothing in the import graph reaches it.
        expect.stringContaining("/host-tools-mcp.mjs"),
      ]),
    );
    const manifest = JSON.parse(
      bootstrap.files.find((file) => file.path.endsWith("/package.json"))!
        .content,
    ) as { dependencies: Record<string, string> };
    // An exact pin, not a range: the committed protocol snapshot and the
    // tool-less model matrix both describe THAT binary.
    expect(manifest.dependencies["@openai/codex"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("declares every dependency the bundled bridge imports", () => {
    // The bundling triple: an import, an esbuild external, and a manifest
    // entry. Miss the third and the bridge dies inside the box with a
    // module-not-found nobody can see.
    const bootstrap = getCodexAppServerBootstrap();
    const bridge = bootstrap.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    )!.content;
    const manifest = JSON.parse(
      bootstrap.files.find((file) => file.path.endsWith("/package.json"))!
        .content,
    ) as { dependencies: Record<string, string> };
    const imported = new Set(
      [...bridge.matchAll(/^import .*? from "([^"]+)";$/gm)]
        .map((match) => match[1]!)
        .filter((specifier) => !specifier.startsWith("node:")),
    );
    for (const specifier of imported) {
      const packageName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0]!;
      // Node builtins reachable without the `node:` prefix are not packages.
      if (
        [
          "fs",
          "path",
          "crypto",
          "process",
          "os",
          "child_process",
          "http",
        ].includes(packageName)
      ) {
        continue;
      }
      expect(
        manifest.dependencies,
        `bridge imports ${packageName}, which the bootstrap manifest must install`,
      ).toHaveProperty(packageName);
    }
  });

  it("verifies the platform binary landed, not just the wrapper", () => {
    // `@openai/codex` is a wrapper that resolves a platform-specific optional
    // dependency. It installs fine on its own and only fails at RUN time with
    // "Missing optional dependency", which would surface as an opaque bridge
    // startup failure minutes later.
    const commands = getCodexAppServerBootstrap().commands.map(
      (c) => c.command,
    );
    expect(commands.some((command) => command.includes("pnpm install"))).toBe(
      true,
    );
    expect(commands.at(-1)).toContain("--version");
  });
});

describe("emitted parts", () => {
  it("the bridge's host-tool call shape is a valid stream part", () => {
    // The relay emits this by hand rather than through the translator, so it
    // gets its own schema check. `providerExecuted: false` is the signal that
    // MCPJam, not Codex, runs the tool — and therefore that the framework's
    // approval gate applies rather than the bridge's.
    const part = {
      type: "tool-call",
      toolCallId: "mcpjam-host-1",
      toolName: "mcp__weather__get_forecast",
      input: JSON.stringify({ city: "Paris" }),
      providerExecuted: false,
    };
    expect(harnessV1StreamPartSchema.safeParse(part).success).toBe(true);
  });
});
