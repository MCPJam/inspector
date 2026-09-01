import { describe, expect, it } from "vitest";
import { HARNESS_IDS } from "@mcpjam/sdk/host-config/internal";
import { HARNESS_MCP_DELIVERY } from "@/shared/harness-mcp-delivery";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import {
  buildBrokerDummyAuth,
  getHarnessAdapter,
  harnessUsesExternalAccount,
  isHarnessId,
  patchClaudeCodeHarnessBootstrap,
  registeredHarnessIds,
} from "../registry";

describe("harness registry", () => {
  it("returns the claude-code adapter", () => {
    expect(getHarnessAdapter("claude-code").id).toBe("claude-code");
  });

  it("returns the codex adapter", () => {
    const a = getHarnessAdapter("codex");
    expect(a.id).toBe("codex");
    expect(a.displayName).toBe("Codex");
    // Codex: MCP servers arrive as HOST-EXECUTED tools (the CLI never makes an
    // MCP tool model-callable in the mode the SDK drives), no native plugin
    // install, can't pause for tool approval — and skills ARE delivered
    // (INS-8), under its own root.
    expect(a.mcpDelivery).toBe("host-executed");
    expect(a.supportsSkills).toBe(true);
    expect(a.skillsBaseDir).toBe("/home/user/.agents/skills");
    expect(a.supportsPluginBundles).toBe(false);
    expect(a.supportsNativeToolApproval).toBe(false);
    expect(a.requiresComputer).toBe(true);
    expect(a.fileChangeToolName).toBe("fileChange");
  });

  it("every adapter that advertises a capability carries its strategy", () => {
    // The repo convention: advertising a capability means implementing it.
    // `runHarnessTurn` throws on a violation at turn time; this catches it in
    // CI, for every registered adapter, before a turn is ever attempted.
    for (const id of registeredHarnessIds()) {
      const adapter = getHarnessAdapter(id);
      // The MCP delivery arms are mutually exclusive BY TYPE (each native
      // MECHANISM requires its own hook; the host-executed arm forbids them
      // all), so this asserts the runtime shape matches the declared mode — the
      // check the compiler makes for real adapters, made again for a
      // hand-edited one.
      if (adapter.mcpDelivery === "native") {
        if (adapter.mcpNativeDelivery === "sandbox-files") {
          // Writes runtime config into the box before the process starts.
          expect(adapter.deliverMcpServers).toBeTypeOf("function");
        } else {
          // The servers are a CONSTRUCTOR setting instead, so there must be
          // nothing to write — a `session-config` adapter that also carried a
          // sandbox write would deliver its servers twice.
          expect(adapter.mcpNativeDelivery).toBe("session-config");
          expect(adapter.deliverMcpServers).toBeUndefined();
        }
      } else {
        expect(adapter.mcpDelivery).toBe("host-executed");
        expect(adapter.mcpNativeDelivery).toBeUndefined();
        expect(adapter.deliverMcpServers).toBeUndefined();
      }
      // Model access is a required declaration, and an external-account adapter
      // must NAME the credential it needs — otherwise the turn runner would
      // start it with no auth and the failure would surface from inside the box.
      expect(["broker", "external-account"]).toContain(adapter.modelAccess);
      if (adapter.modelAccess === "external-account") {
        expect(adapter.externalAccountCredentialEnv.length).toBeGreaterThan(0);
      } else {
        expect(adapter.externalAccountCredentialEnv).toBeUndefined();
      }
      if (adapter.supportsPluginBundles) {
        expect(adapter.deliverPluginBundles).toBeTypeOf("function");
      }
      if (adapter.supportsSkills) {
        expect(adapter.skillsBaseDir.startsWith("/")).toBe(true);
      }
    }
  });

  it("no adapter claims native plugin-bundle installation yet (INS-8)", () => {
    // Codex exposes no plugin-install hook and cannot surface a plugin's MCP
    // tools to the model at all (openai/codex#19425); Claude Code delivers a
    // plugin's COMPONENTS, not a plugin unit. Neither is a bundle install, so
    // neither flag may be on. Flipping one without a parity test is exactly the
    // failure this asserts against.
    for (const id of registeredHarnessIds()) {
      expect(getHarnessAdapter(id).supportsPluginBundles).toBe(false);
    }
  });

  it("maps Gateway Anthropic model ids to Claude Code selectable models", () => {
    const { toNativeModel } = getHarnessAdapter("claude-code");
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBe("haiku");
    expect(toNativeModel?.("anthropic/claude-opus-4.7")).toBe(
      "claude-opus-4-7",
    );
    expect(toNativeModel?.("anthropic/claude-opus-4-6")).toBe(
      "claude-opus-4-6",
    );
    expect(toNativeModel?.("anthropic/claude-sonnet-4.6")).toBe(
      "claude-sonnet-4-6",
    );
    expect(toNativeModel?.("anthropic/claude-sonnet-5")).toBe(
      "claude-sonnet-5",
    );
    // Dated/pinned snapshot suffix (the exact shape Claude Code's own alias
    // resolution can produce on the wire — see the bridge's modelOverrides
    // keys) must still resolve to the haiku alias, not fall through to
    // undefined (which would silently drop the model pin).
    expect(toNativeModel?.("anthropic/claude-haiku-4-5-20251001")).toBe(
      "haiku",
    );
    expect(toNativeModel?.("anthropic/claude-sonnet-4-5-20250929")).toBe(
      "claude-sonnet-4-5",
    );
    // Major-only dated snapshot (no minor version between major and date):
    // the optional minor group's greedy digit match must not swallow the
    // date as if it were a minor version.
    expect(toNativeModel?.("anthropic/claude-opus-4-20250929")).toBe(
      "claude-opus-4",
    );
    // A bare substring match must NOT route a non-Anthropic/malformed id to
    // Claude Code's haiku alias (the regex-gated shortcut, not a loose
    // .includes check).
    expect(toNativeModel?.("openai/my-haiku-experiment")).toBeUndefined();
    expect(toNativeModel?.("openai/gpt-5")).toBeUndefined();
  });

  it("maps Codex models via an allowlist (gpt-5 family only)", () => {
    const { toNativeModel } = getHarnessAdapter("codex");
    expect(toNativeModel?.("openai/gpt-5-nano")).toBe("gpt-5-nano");
    expect(toNativeModel?.("openai/gpt-5.5")).toBe("gpt-5.5");
    // Not a blanket strip: non-gpt-5 OpenAI ids ⇒ undefined (Codex default).
    expect(toNativeModel?.("openai/o1")).toBeUndefined();
    // Non-OpenAI ids never map.
    expect(toNativeModel?.("anthropic/claude-haiku-4.5")).toBeUndefined();
  });

  // The per-protocol gateway base-URL normalizers were removed with the
  // raw-key credential path (COMP-23) — the broker's proxyBaseUrl arrives
  // already protocol-correct from the backend.

  it("supportsModel: Claude Code runs anything, Codex only gpt-5", () => {
    const cc = getHarnessAdapter("claude-code");
    const codex = getHarnessAdapter("codex");
    expect(cc.supportsModel("anthropic/claude-haiku-4.5")).toBe(true);
    expect(cc.supportsModel("openai/gpt-5-nano")).toBe(true);
    expect(codex.supportsModel("openai/gpt-5-nano")).toBe(true);
    // MCPJam-provided but not Codex-mappable ⇒ unsupported (rejected in preflight).
    expect(codex.supportsModel("anthropic/claude-haiku-4.5")).toBe(false);
    expect(codex.supportsModel("openai/o1")).toBe(false);
  });

  it("patches the Claude Code bridge bootstrap compatibility gaps", async () => {
    // The fixture quotes the CURRENT installed bridge's anchor sites VERBATIM
    // (from @ai-sdk/harness-claude-code dist/bridge/index.mjs on the 1.0.x
    // stable line): every needle the patcher matches must appear here exactly
    // as it does in the real bundle, or this test passes while the real patch
    // throws. The installed-package test below is the drift alarm; this one
    // pins WHAT the patch does to a bridge shaped like today's.
    const harness = patchClaudeCodeHarnessBootstrap({
      getBootstrap: async () => ({
        harnessId: "claude-code",
        bootstrapDir: "/tmp/harness/claude-code",
        files: [
          {
            path: "/tmp/harness/claude-code/bridge.mjs",
            content: `var HOST_TOOL_PREFIX = "mcp__harness-tools__";
function createEmitStreamEvent({
  state,
  emit,
  emitTerminalError
}) {
  let streamStarted = false;
  return (msg) => {
    const type = msg.type;
    if (msg.parent_tool_use_id != null) {
      return;
    }
    if (type === "stream_event") {
      handleStreamEvent({
        event: msg.event,
        state,
        send: emit
      });
      return;
    }
    if (type === "assistant" && msg.message?.content) {
      let opensStep = false;
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          opensStep = true;
          emit({ type: "tool-call" });
        }
      }
      if (opensStep) {
        state.stepOpen = true;
      }
      return;
    }
  };
}
async function drive() {
  const permissionOptions = createPermissionOptions({
    start,
    turn,
    emit
  });
  const q = claudeSdk.query({
    options: {
      ...start.model ? { model: start.model } : {},
      ...start.maxTurns !== void 0 ? { maxTurns: start.maxTurns } : {},
      ...permissionOptions,
      mcpServers,
      cwd: workdir,
      abortSignal: abortCtl.signal
    }
  });
}
const toUserMessage = (options) => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "text", text: options.text }]
  },
  parent_tool_use_id: null,
  uuid: options.messageId
});`,
          },
        ],
        commands: [],
      }),
    } as any);

    const bootstrap = await harness.getBootstrap?.();
    const bridge = bootstrap?.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    );
    // The adapter sets `parent_tool_use_id: null` on outbound user messages
    // ITSELF since the stable line; the patcher no longer injects it, it
    // VERIFIES the string is still present (a future adapter dropping it would
    // silently stop filtering sub-agent streams, so the patcher throws).
    expect(bridge?.content).toContain("parent_tool_use_id: null");
    expect(bridge?.content).toContain("emitAssistantTextFallback");
    expect(bridge?.content).toContain("streamedAssistantText = true");
    expect(bridge?.content).toContain("emitAssistantTextFallback(block.text)");
    expect(bridge?.content).toContain("emitAssistantTextFallback(msg.result)");
    // The result fallback lives INSIDE createEmitStreamEvent now (stable's
    // turn loop routes the terminal `result` message through it), gated on the
    // success subtype so an error result never masquerades as assistant text.
    expect(bridge?.content).toContain(
      'type === "result" && msg.subtype === "success"',
    );
    // Fallback text must open a step (mirroring the adapter's own
    // structured-output path) or the emitted parts are dropped, and its ids
    // are namespaced so they can never collide with adapter-generated ids.
    expect(bridge?.content).toContain("state.stepOpen = true;");
    expect(bridge?.content).toContain("mcpjam-fallback-");
    expect(bridge?.content).toContain("gatewayModelOverrideSettingsFor");
    expect(bridge?.content).toContain("modelOverrides");
    expect(bridge?.content).toContain("anthropic/claude-");
    expect(bridge?.content).toContain("claude-haiku-4-5-20251001");
    // The overrides MERGE over `permissionOptions.settings` (the adapter's own
    // settings, spread last into the query options): injecting a bare
    // `settings` key earlier in the literal would be silently clobbered.
    expect(bridge?.content).toContain(
      "settings: { ...(permissionOptions.settings ?? {})",
    );
    // Fallback dedup only suppresses an EXACT repeat of the immediately prior
    // fallback (e.g. msg.result echoing the last text block) — never a full
    // history Set, which would drop legitimate non-adjacent repeats, and
    // never a "first-emission-only" flag, which would silently swallow a
    // distinct trailing msg.result (the real final answer) after any earlier
    // fallback fired.
    expect(bridge?.content).toContain("let lastEmittedFallbackText");
    expect(bridge?.content).toContain("normalized === lastEmittedFallbackText");
    expect(bridge?.content).not.toContain("emittedAssistantTextFallbacks");
    // Gateway compat for output_config.effort moved OUT of the bridge patch:
    // stable's createClaudeCode takes a first-class `env`, so the registry
    // passes CLAUDE_CODE_EFFORT_LEVEL as configuration (see createHarness)
    // instead of rewriting bridge source. The patched bridge must NOT carry
    // the old `??=` write — reintroducing it would shadow the configured env.
    expect(bridge?.content).not.toContain("CLAUDE_CODE_EFFORT_LEVEL");
  });

  it("throws loudly if the adapter stops setting parent_tool_use_id itself", async () => {
    // The retired injection patch became an assertion: a bridge without the
    // string means the sub-agent guard (and the adapter's own user-message
    // stamping) changed shape, and shipping it unverified would let a
    // sub-agent's stream merge into the parent transcript.
    const harness = patchClaudeCodeHarnessBootstrap({
      getBootstrap: async () => ({
        harnessId: "claude-code",
        bootstrapDir: "/tmp/harness/claude-code",
        files: [
          {
            path: "/tmp/harness/claude-code/bridge.mjs",
            // Already-patched markers so the group patches are skipped and
            // only the verification runs — isolating the assertion under test.
            content: `emitAssistantTextFallback; gatewayModelOverrideSettingsFor;`,
          },
        ],
        commands: [],
      }),
    } as any);

    await expect(harness.getBootstrap?.()).rejects.toThrow(
      "Unable to verify Claude Code bridge bootstrap: user-message shape changed",
    );
  });

  it("patches the installed Claude Code bridge bootstrap", async () => {
    const harness = patchClaudeCodeHarnessBootstrap(
      createClaudeCode({
        model: "haiku",
        // Stable's environment auth arm (the canary `gateway` object is gone).
        auth: {
          AI_GATEWAY_API_KEY: "test",
          AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v1",
        },
      }) as any,
    );

    const bootstrap = await harness.getBootstrap?.();
    const bridge = bootstrap?.files.find((file) =>
      file.path.endsWith("/bridge.mjs"),
    );
    // The adapter's own user-message stamping (verified, no longer injected).
    expect(bridge?.content).toContain("parent_tool_use_id: null");
    expect(bridge?.content).toContain("emitAssistantTextFallback");
    expect(bridge?.content).toContain(
      'type === "result" && msg.subtype === "success"',
    );
    expect(bridge?.content).toContain("mcpjam-fallback-");
    expect(bridge?.content).toContain("gatewayModelOverrideSettingsFor");
    expect(bridge?.content).toContain("modelOverrides");
    expect(bridge?.content).toContain("claude-haiku-4-5-20251001");
    expect(bridge?.content).toContain(
      "settings: { ...(permissionOptions.settings ?? {})",
    );
    // The effort-level compat knob is createClaudeCode `env` configuration
    // now, not a bridge-source rewrite (the installed bridge has no reference
    // at all, so a reappearing one means the patch regressed to the old form).
    expect(bridge?.content).not.toContain("CLAUDE_CODE_EFFORT_LEVEL");
  });

  it("writes an .npmrc that lets the bootstrap's pnpm run build scripts", async () => {
    const harness = patchClaudeCodeHarnessBootstrap(
      createClaudeCode({
        model: "haiku",
        auth: {
          AI_GATEWAY_API_KEY: "test",
          AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v1",
        },
      }) as any,
    );

    const bootstrap = await harness.getBootstrap?.();
    const npmrc = bootstrap?.files.find((file) =>
      file.path.endsWith("/.npmrc"),
    );
    const workspaces = bootstrap?.files.filter((file) =>
      file.path.endsWith("/pnpm-workspace.yaml"),
    );

    // Without this, pnpm skips `@anthropic-ai/claude-code`'s postinstall and
    // the CLI never exists — the bootstrap dies before a single turn.
    //
    // TWO layers, one file each, and neither is redundant: the stable adapter
    // ships its OWN `pnpm-workspace.yaml` pinning the build by exact version
    // (`allowBuilds`, the pnpm 11 spelling), and our `.npmrc` carries the
    // pnpm 10 spelling — the computer template installs pnpm UNPINNED, so a
    // not-yet-rebuilt box still resolves pnpm 10, which reads none of its
    // settings from `pnpm-workspace.yaml`.
    expect(npmrc?.path).toBe(`${bootstrap?.bootstrapDir}/.npmrc`);
    expect(npmrc?.content).toContain("dangerously-allow-all-builds=true");
    // Exactly ONE pnpm-workspace.yaml, and it is the ADAPTER's version-pinned
    // allow-list — ours is only a fallback for an adapter that ships none, and
    // appending a second entry for the same path would write the file twice
    // with conflicting content.
    expect(workspaces).toHaveLength(1);
    expect(workspaces?.[0]?.path).toBe(
      `${bootstrap?.bootstrapDir}/pnpm-workspace.yaml`,
    );
    expect(workspaces?.[0]?.content).toContain("allowBuilds:");
    expect(workspaces?.[0]?.content).toMatch(
      /'@anthropic-ai\/claude-code@[\d.]+': true/,
    );
    expect(workspaces?.[0]?.content).not.toContain("dangerouslyAllowAllBuilds");

    // The second, load-bearing layer for pnpm 10: even if the allow-list
    // setting is renamed again, a skipped build must stay a WARNING so the
    // install step exits zero and the version check below is what reports the
    // broken CLI.
    expect(npmrc?.content).toContain("strict-dep-builds=false");
    // Recent adapter versions retain a conditional `install.cjs` rescue for
    // older images while still verifying that the CLI materialized. If the
    // rescue is present it must be guarded by the file check, so a missing
    // optional postinstall cannot make the bootstrap fail before `--version`.
    const installCommand = bootstrap?.commands.find((command) =>
      command.command.includes("install.cjs"),
    );
    if (installCommand) {
      expect(installCommand.command).toContain(
        "if [ -f node_modules/@anthropic-ai/claude-code/install.cjs ]; then",
      );
    }
    expect(
      bootstrap?.commands.some((command) =>
        command.command.includes("claude --version"),
      ),
    ).toBe(true);

    // It has to sit BESIDE the adapter's manifest, not inside it: the install
    // runs `--frozen-lockfile`, so amending `package.json` to carry
    // `onlyBuiltDependencies` would fail the lockfile check. Both halves of
    // that reasoning are pinned here so a future edit cannot quietly break one.
    const manifest = bootstrap?.files.find((file) =>
      file.path.endsWith("/package.json"),
    );
    if (manifest) {
      expect(JSON.parse(manifest.content).pnpm).toBeUndefined();
    }
    expect(
      bootstrap?.commands.some((command) =>
        command.command.includes("--frozen-lockfile"),
      ),
    ).toBe(true);
  });

  it("Claude Code attributes mcp__ tool names", () => {
    const keyToServerId = { weather: "srv_123" };
    expect(
      getHarnessAdapter("claude-code").parseToolName(
        "mcp__weather__forecast",
        keyToServerId,
      ),
    ).toEqual({ serverId: "srv_123", toolName: "forecast" });
    // Codex used to pass these through verbatim (it had no MCP tools to name).
    // It now uses the SAME scheme — see the parity block below.
  });

  it("isHarnessId narrows registered ids and rejects junk", () => {
    expect(isHarnessId("claude-code")).toBe(true);
    expect(isHarnessId("codex")).toBe(true);
    expect(isHarnessId("pi")).toBe(false);
    expect(isHarnessId("__proto__")).toBe(false);
    expect(isHarnessId(undefined)).toBe(false);
  });

  it("registry keys are at parity with the SDK HARNESS_IDS (no drift)", () => {
    expect([...registeredHarnessIds()].sort()).toEqual([...HARNESS_IDS].sort());
  });

  it("throws for an unknown harness id (e.g. a not-yet-installed adapter)", () => {
    // `pi` is a plausible-but-unregistered runtime (codex is now installed).
    expect(() => getHarnessAdapter("pi")).toThrow(/Unsupported harness/);
  });

  describe("deliverMcpServers (refactor guard — Claude .mcp.json unchanged)", () => {
    const mcpJson = {
      mcpServers: {
        weather: { type: "http" as const, url: "https://example.com/mcp" },
      },
    };

    it("Claude Code writes the same path + content the inline write did", async () => {
      const adapter = getHarnessAdapter("claude-code");
      const writes: { path: string; content: string }[] = [];
      await adapter.deliverMcpServers?.({
        writeTextFile: async (a) => {
          writes.push(a);
        },
        sessionWorkDir: "/home/user/work",
        mcpJson,
      });
      expect(writes).toHaveLength(1);
      expect(writes[0]!.path).toBe("/home/user/work/.mcp.json");
      // Content is the canonical serialization (same helper as before the refactor).
      expect(JSON.parse(writes[0]!.content)).toEqual(mcpJson);
    });

    it("Codex writes no sandbox MCP config — its servers are host-executed", () => {
      // The COMP-39 spike proved `~/.codex/config.toml` `[mcp_servers]` merges
      // cleanly and is still a silent no-op (the model never gets a callable
      // tool). Writing it anyway would be the trap; the relay is the mechanism.
      const codex = getHarnessAdapter("codex");
      expect(codex.mcpDelivery).toBe("host-executed");
      expect(codex.deliverMcpServers).toBeUndefined();
    });

    it("Claude Code's tools are NOT projected as host-executed (no double exposure)", () => {
      // The mutual-exclusion invariant, from the consumer's side: the native
      // adapter must stay on the `.mcp.json` path, so `runHarnessTurn` never
      // adds MCP tools to its host-executed tool set and the model never sees
      // the same tool twice.
      expect(getHarnessAdapter("claude-code").mcpDelivery).toBe("native");
    });

    it("every adapter's delivery mode IS the shared declaration the client reads", () => {
      // `@/shared/harness-mcp-delivery` is the one declaration of which mode a
      // harness uses, because the CLIENT has to derive Behavior-tab promises
      // from it (a tool-construction-time knob like `respectToolVisibility`
      // bites on host-executed delivery and cannot on native) and cannot import
      // this server-only registry.
      //
      // This is the anti-drift guard for that split. If someone flips an
      // adapter's `mcpDelivery` back to a literal — or changes the shared map
      // without the adapters — the host editor would start disabling a control
      // that works (or enabling one that doesn't) with no compile error. Fail
      // here instead.
      for (const id of registeredHarnessIds()) {
        expect(getHarnessAdapter(id).mcpDelivery).toBe(
          HARNESS_MCP_DELIVERY[id],
        );
      }
      // …and the shared map covers exactly the SDK's harness ids, so a new
      // harness cannot get an adapter without a delivery declaration.
      expect(Object.keys(HARNESS_MCP_DELIVERY).sort()).toEqual(
        [...HARNESS_IDS].sort(),
      );
    });
  });

  describe("parseToolName (cross-harness attribution parity)", () => {
    const keyToServerId = { weather: "srv-weather" };

    it("both harnesses resolve mcp__<server>__<tool> to the same identity", () => {
      // Eval assertions and trace spans key off `{ serverId, toolName }`. A
      // Codex run must attribute a relayed call exactly as a Claude Code run
      // attributes the native one, or the same suite scores differently per
      // harness for reasons that have nothing to do with the server.
      for (const id of registeredHarnessIds()) {
        expect(
          getHarnessAdapter(id).parseToolName(
            "mcp__weather__get_forecast",
            keyToServerId,
          ),
        ).toEqual({ serverId: "srv-weather", toolName: "get_forecast" });
      }
    });

    it("a harness-native tool name keeps no server attribution", () => {
      for (const id of registeredHarnessIds()) {
        expect(
          getHarnessAdapter(id).parseToolName("bash", keyToServerId),
        ).toEqual({ toolName: "bash" });
      }
    });

    it("an unknown server key is returned verbatim, never fabricated", () => {
      for (const id of registeredHarnessIds()) {
        expect(
          getHarnessAdapter(id).parseToolName("mcp__ghost__do_thing", {}),
        ).toEqual({ toolName: "mcp__ghost__do_thing" });
      }
    });
  });

  describe("listBuiltinTools (display catalog)", () => {
    // The set evolves with the published adapter, so assert MEMBERSHIP of known
    // tools — never a fixed count.
    const list = getHarnessAdapter("claude-code").listBuiltinTools();

    it("constructs without auth/sandbox and returns a non-empty catalog", () => {
      expect(list.length).toBeGreaterThan(0);
    });

    it("includes the known core + native-only tools (keyed by record key)", () => {
      const keys = new Set(list.map((t) => t.key));
      for (const expected of [
        "read",
        "write",
        "edit",
        "bash",
        "glob",
        "grep",
        "webSearch",
        "WebFetch",
        "NotebookEdit",
      ]) {
        expect(keys).toContain(expected);
      }
    });

    it("normalizes every entry: non-empty name, JSON-Schema where present, sorted", () => {
      for (const t of list) {
        expect(typeof t.name).toBe("string");
        expect(t.name.length).toBeGreaterThan(0);
        if (t.inputSchema !== undefined) {
          expect(typeof t.inputSchema).toBe("object");
        }
      }
      const names = list.map((t) => t.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });

    it("at least one tool exposes a usable input schema (bash/read take params)", () => {
      const withSchema = list.filter((t) => t.inputSchema !== undefined);
      expect(withSchema.length).toBeGreaterThan(0);
    });
  });
});

describe("cursor adapter (Cursor CLI / ACP)", () => {
  const cursor = getHarnessAdapter("cursor");

  it("constructs, and declares the external-account posture", () => {
    expect(cursor.id).toBe("cursor");
    // "Cursor CLI", not "Cursor": the emulated `cursor` host style is the IDE
    // chat panel, and every preflight message a user reads comes from here.
    expect(cursor.displayName).toBe("Cursor CLI");
    expect(cursor.requiresComputer).toBe(true);
    expect(cursor.modelAccess).toBe("external-account");
    expect(harnessUsesExternalAccount("cursor")).toBe(true);
    // The name the CLI itself reads (the adapter package declares the same one
    // as its `credentialEnv`). A drift here is a turn started with no auth.
    expect(cursor.externalAccountCredentialEnv).toEqual(["CURSOR_API_KEY"]);
  });

  it("delivers MCP natively, through the SESSION CONFIG rather than a file", () => {
    // The MODE decides evidence capture (does the traffic cross MCPJam's
    // proxy?) and must match the shared declaration the client reads; the
    // MECHANISM decides how it is handed over. Both are asserted because they
    // are separate facts that happen to travel together here.
    expect(cursor.mcpDelivery).toBe("native");
    expect(cursor.mcpDelivery).toBe(HARNESS_MCP_DELIVERY.cursor);
    expect(cursor.mcpNativeDelivery).toBe("session-config");
    expect(cursor.deliverMcpServers).toBeUndefined();
  });

  it("normalizes its builtin tool catalog without auth or a sandbox", () => {
    const tools = cursor.listBuiltinTools();
    // The ACP wrapper carries a static catalog, which is what lets the generic
    // /v1/harness/:id/builtin-tools route work with no per-harness code.
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.map((t) => t.key)).toContain("bash");
    // Display-normalized: every entry has a name, and the list is sorted so the
    // route's output is stable across processes.
    expect(tools.every((t) => typeof t.name === "string" && t.name)).toBe(true);
    expect(tools.map((t) => t.name)).toEqual(
      [...tools.map((t) => t.name)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it("passes NO native model (Cursor Auto picks on the customer's account)", () => {
    expect(
      cursor.toNativeModel?.("anthropic/claude-sonnet-4.5"),
    ).toBeUndefined();
    expect(cursor.toNativeModel?.("cursor/auto")).toBeUndefined();
  });

  it("declares the approval posture it can actually keep", () => {
    // Verified against a live cursor-agent: the ACP bridge pauses on its own
    // built-ins under "allow-reads".
    expect(cursor.supportsNativeToolApproval).toBe(true);
    expect(cursor.approvalPermissionMode).toBe("allow-reads");
    // NOT claimed, pending a live MCP-approval measurement. False means an
    // approval host with servers attached is REFUSED at preflight rather than
    // run with some MCP calls unapproved — the conservative direction, and the
    // one this flag exists to protect.
    expect(cursor.supportsMcpToolApproval).toBe(false);
    expect(cursor.supportsHostExecutedToolApproval).toBe(false);
  });

  it("constructs a harness from the MCP json it is handed", () => {
    // The `session-config` arm's signature REQUIRES mcpJson, so this is also
    // the compile-time proof that the config cannot be dropped at construction.
    const runtime = cursor.createHarness({
      modelId: "cursor/auto",
      auth: { CURSOR_API_KEY: "sk-test" },
      mcpJson: {
        mcpServers: {
          weather: { type: "http", url: "https://proxy.example/weather" },
        },
      },
    });
    expect(runtime.harnessId).toBe("cursor");
  });

  it("shell-quotes the workdir so a metacharacter path cannot execute", () => {
    // The workdir is host-configured. `resolveWorkingDirectory` confines it to
    // /home/user but does NOT reject shell metacharacters, so this command is
    // the injection surface: it is built as a string and handed to a shell in
    // the box during session setup.
    //
    // These assert the EMITTED BYTES, not the intent. The first version of this
    // used a template literal — where `\'` is just `'`, so the escape silently
    // collapsed to three quotes, closing the quoted word and leaving the rest
    // of the path unquoted. It read correctly and did nothing.
    const cmd = (dir: string) =>
      getHarnessAdapter("cursor").runtimeVersionCommand!(dir);

    // A plain path is wrapped in single quotes and otherwise untouched.
    expect(cmd("/home/user")).toBe(
      "'/home/user/.harness-bootstrap/cursor/implementation/home/.local/bin/agent' --version",
    );

    // Command substitution stays INSIDE the quotes, so the shell never runs it.
    for (const dangerous of [
      "/home/user/$(id)",
      "/home/user/`id`",
      "/home/user/$IFS",
    ]) {
      const out = cmd(dangerous);
      expect(out.startsWith("'" + dangerous + "/")).toBe(true);
      // Balanced quoting, and nothing outside it but the flag.
      expect(out.endsWith("agent' --version")).toBe(true);
      expect((out.match(/'/g) ?? []).length % 2).toBe(0);
    }

    // An apostrophe is closed, escaped and reopened — never three bare quotes.
    const withQuote = cmd("/home/user/it's");
    expect(withQuote).toContain("it'\\''s");
    expect(withQuote).not.toContain("it'''s");
  });

  it("names a runtime-version command (its CLI is NOT pinned by the package pin)", () => {
    // The bootstrap installs via `curl https://cursor.com/install | bash`,
    // which always fetches the current build — so what ran is only knowable by
    // asking the box. The other two adapters bootstrap a pinned npm package and
    // correctly declare nothing.
    expect(cursor.runtimeVersionCommand?.("/home/user")).toContain("--version");
    expect(
      getHarnessAdapter("claude-code").runtimeVersionCommand,
    ).toBeUndefined();
    expect(getHarnessAdapter("codex").runtimeVersionCommand).toBeUndefined();
  });
});

describe("buildBrokerDummyAuth", () => {
  it("gives each brokered harness its own credential shape", () => {
    const claude = buildBrokerDummyAuth("claude-code", "https://proxy.example");
    expect(claude.ANTHROPIC_BASE_URL).toBe("https://proxy.example");
    expect(claude.ANTHROPIC_AUTH_TOKEN).toBeTruthy();
    // Deliberately absent, not empty: the adapter keys its credential-forwarding
    // transforms off which variables are PRESENT.
    expect(claude.ANTHROPIC_API_KEY).toBeUndefined();

    const codex = buildBrokerDummyAuth("codex", "https://proxy.example");
    expect(codex.OPENAI_BASE_URL).toBe("https://proxy.example");
    expect(codex.CODEX_API_KEY).toBeTruthy();
  });

  it("THROWS for an external-account harness rather than defaulting", () => {
    // This was a fallthrough `if (codex) … else Anthropic`, so a cursor id would
    // have silently received Claude Code's ANTHROPIC_* environment — a dummy
    // token and a base URL for a proxy it never talks to, failing later and
    // opaquely from inside the box. Asking for broker auth here is a caller bug
    // and now says so.
    expect(() =>
      buildBrokerDummyAuth("cursor", "https://proxy.example"),
    ).toThrow(/external-account|does not|no broker|takes no/i);
  });

  it("covers every brokered harness in the registry", () => {
    // Exhaustiveness at runtime as well as in the type: a brokered harness
    // added without a credential shape would throw the `default` branch's
    // error, which this would catch.
    for (const id of registeredHarnessIds()) {
      const adapter = getHarnessAdapter(id);
      if (adapter.modelAccess === "external-account") continue;
      expect(
        Object.keys(buildBrokerDummyAuth(id, "https://proxy.example")).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("bootstrap recipes are auth-independent", () => {
  // Load-bearing for the in-stream bootstrap. A harness turn installs its
  // runtime inside the sandbox after the broker starts, using a runtime built
  // with dummy broker creds. The framework keys the "already installed" marker
  // on a hash of the recipe's file contents, so if the recipe ever varied with
  // auth, a resume would re-run the bootstrap against a different hash. The
  // recipe must stay auth-independent so the in-stream bootstrap is
  // attributable to the adapter, not to whichever credential happened to be
  // present when the files were hashed.
  // The stable line's flat ENVIRONMENT auth arm — one env map serves both
  // adapters (each reads only its own variables).
  const auth = (suffix: string) => ({
    ANTHROPIC_AUTH_TOKEN: `anthropic-token-${suffix}`,
    ANTHROPIC_BASE_URL: `https://${suffix}.invalid`,
    CODEX_API_KEY: `openai-key-${suffix}`,
    OPENAI_BASE_URL: `https://${suffix}.invalid`,
    // Cursor's credential varies too, or the cursor arm of the loop below
    // compares two runs handed the SAME value — which cannot detect a
    // `CURSOR_API_KEY` written into a bootstrap file, the one leak the
    // external-account harness makes possible.
    CURSOR_API_KEY: `cursor-key-${suffix}`,
  });

  /**
   * Construct any adapter, satisfying whichever arm it declares.
   *
   * Mirrors the narrowing `runHarnessTurn` does at its own construction site:
   * a `session-config` adapter's `createHarness` REQUIRES `mcpJson`, so a test
   * that called every adapter with the same argument shape would not typecheck
   * — which is the invariant doing its job, not an obstacle to route around.
   */
  const makeHarness = (
    adapter: ReturnType<typeof getHarnessAdapter>,
    args: { modelId: string; auth: ReturnType<typeof auth> },
  ) =>
    adapter.mcpDelivery === "native" &&
    adapter.mcpNativeDelivery === "session-config"
      ? adapter.createHarness({ ...args, mcpJson: { mcpServers: {} } })
      : adapter.createHarness(args);

  // cursor included: its bootstrap fetches the CLI with `curl … | bash`, so an
  // auth-dependent recipe there would re-run that install on every resume.
  for (const id of ["claude-code", "codex", "cursor"] as const) {
    it(`${id}: two different credentials produce byte-identical files`, async () => {
      const adapter = getHarnessAdapter(id);
      const modelId =
        id === "codex"
          ? "openai/gpt-5-nano"
          : id === "cursor"
          ? "cursor/auto"
          : "anthropic/claude-haiku-4.5";
      const a = makeHarness(adapter, { modelId, auth: auth("one") });
      const b = makeHarness(adapter, { modelId, auth: auth("two") });

      const ra = await a.getBootstrap!();
      const rb = await b.getBootstrap!();

      // ORDER MATTERS, and it is the whole value of this block. Every value in
      // `auth()` varies by suffix, so a leaked credential makes the two runs
      // DIFFER — meaning the equality assertions below would throw first, on a
      // multi-kilobyte tree diff, and a scan placed after them could never run.
      // Scanned after the fact it is also unfalsifiable: if equality passed,
      // the two runs are identical and no suffix-varying value can be present.
      //
      // So: scan first, each run against its OWN credentials, and name the
      // VARIABLE rather than printing its value.
      // `commands` is `{ command: string }[]`, not `string[]` — spreading it
      // straight into the join stringifies each entry as "[object Object]" and
      // makes the scan blind to command TEXT, which is exactly where a
      // credential passed as an argument would sit.
      const emitted = (r: typeof ra) =>
        [
          ...r.commands.map((c) => c.command),
          ...r.files.map((f) => `${f.path}\n${f.content}`),
        ].join("\n");
      for (const [output, creds] of [
        [emitted(ra), auth("one")],
        [emitted(rb), auth("two")],
      ] as const) {
        for (const [name, value] of Object.entries(creds)) {
          expect(output, `${id} bootstrap embeds ${name}`).not.toContain(value);
        }
      }

      // The backstop: catches anything else that varies with auth, including a
      // credential DERIVED into some form the literal scan above cannot see.
      // `hashBootstrap` is not exported, so compare exactly what it hashes.
      expect(rb.harnessId).toBe(ra.harnessId);
      expect(rb.bootstrapDir).toBe(ra.bootstrapDir);
      expect(rb.commands).toEqual(ra.commands);
      expect(rb.files).toEqual(ra.files);
    });
  }

  it("claude-code's patched bridge differs from the unpatched one", () => {
    // The other half of the same invariant: the registry rewrites the bridge
    // asset, so bootstrapping a bare `createClaudeCode()` would compute a
    // different hash than the turn does. This test is what makes that
    // divergence visible if anyone reaches for the bare constructor.
    // Dual-`ai` boundary cast, as everywhere else this constructor is used.
    const patched = makeHarness(getHarnessAdapter("claude-code"), {
      modelId: "anthropic/claude-haiku-4.5",
      auth: auth("patched"),
    });
    return Promise.all([
      patched.getBootstrap!(),
      createClaudeCode().getBootstrap!(),
    ]).then(([p, bare]) => {
      const bridgeOf = (r: {
        files: readonly { path: string; content: string }[];
      }) => r.files.find((f) => f.path.endsWith("/bridge.mjs"))!.content;
      expect(bridgeOf(p)).not.toBe(bridgeOf(bare));
    });
  });
});
