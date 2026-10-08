/**
 * Claude Code bootstrap shared by runtime dispatch, pack builds and conformance.
 * Keep this module independent of the application registry: pack CI does not
 * build the MCPJam SDK or initialize server services.
 */
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { patchClaudeCodeBackgroundDrain } from "./claude-code-background-drain.js";
import { patchClaudeCodeSubagentSteps } from "./claude-code-subagent-steps.js";

export function createClaudeCodeHarness(
  settings?: Parameters<typeof createClaudeCode>[0],
): HarnessAgentAdapter {
  // The adapter and Inspector may resolve separate copies of the harness types.
  return patchClaudeCodeHarnessBootstrap(
    createClaudeCode(settings) as unknown as HarnessAgentAdapter,
  );
}

/* ── Claude Code bridge patches ────────────────────────────────────────────
 *
 * Groups B and C survive on the `@ai-sdk/harness-claude-code@1.0.x` stable
 * line; Group D (background drain) lives in `claude-code-background-drain.ts`
 * and Group E (a subagent's steps) in `claude-code-subagent-steps.ts`.
 * A third — injecting `parent_tool_use_id: null` into the outbound user message
 * — was RETIRED at the stable bump: the adapter's own `toUserMessage` now sets
 * it, and re-applying ours would have written the key twice.
 *
 * Every needle below is quoted from the vendored `dist/bridge/index.mjs` and
 * must match VERBATIM. A miss throws rather than silently shipping an
 * unpatched bridge; `registry.test.ts` runs the patcher against the really
 * installed package so a version bump fails loudly here instead of at runtime.
 */

/** Group B — assistant-text fallback.
 *
 *  The bridge emits assistant text ONLY from `stream_event` text deltas. When
 *  the CLI returns a non-streamed response the turn ends with empty output, so
 *  we synthesize text parts from the assistant message's text blocks and, as a
 *  last resort, from the terminal `result`.
 *
 *  Everything lives inside `createEmitStreamEvent`, whose closure already owns
 *  `emit` and the per-turn `state`. On the canary line the `result` fallback sat
 *  in the main turn loop; on stable that loop calls `emitStreamEvent(msg)` for
 *  the `result` message too, so both fallbacks share one scope and one dedup
 *  variable. */
const CLAUDE_CODE_BRIDGE_TEXT_STATE_NEEDLE = `  let streamStarted = false;
  return (msg) => {
    const type = msg.type;`;
const CLAUDE_CODE_BRIDGE_TEXT_STATE_PATCH = `  let streamStarted = false;
  let streamedAssistantText = false;
  let lastEmittedFallbackText;
  let fallbackTextSeq = 0;
  const emitAssistantTextFallback = (text) => {
    const normalized = typeof text === "string" ? text : "";
    if (!normalized || streamedAssistantText || normalized === lastEmittedFallbackText) return;
    const id = \`mcpjam-fallback-\${Date.now()}-\${++fallbackTextSeq}\`;
    emit({ type: "text-start", id });
    emit({ type: "text-delta", id, delta: normalized });
    emit({ type: "text-end", id });
    lastEmittedFallbackText = normalized;
    // Mirror the adapter's own structured-output path: text emitted outside a
    // step is dropped unless the step is open when the result arrives.
    state.stepOpen = true;
  };
  return (msg) => {
    const type = msg.type;`;

const CLAUDE_CODE_BRIDGE_STREAM_EVENT_NEEDLE = `    if (type === "stream_event") {
      handleStreamEvent({`;
const CLAUDE_CODE_BRIDGE_STREAM_EVENT_PATCH = `    if (type === "stream_event") {
      if (msg.event?.type === "content_block_delta" && msg.event?.delta?.type === "text_delta" && typeof msg.event?.delta?.text === "string" && msg.event.delta.text.length > 0) {
        streamedAssistantText = true;
      }
      handleStreamEvent({`;

const CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_NEEDLE = `      for (const block of msg.message.content) {
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {`;
const CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_PATCH = `      for (const block of msg.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          emitAssistantTextFallback(block.text);
          continue;
        }
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {`;

/** `createEmitStreamEvent` has no `result` branch of its own, so this adds one.
 *  It is anchored AFTER the `parent_tool_use_id` sub-agent guard so a subagent's
 *  terminal result never leaks into the parent transcript. */
const CLAUDE_CODE_BRIDGE_RESULT_TEXT_NEEDLE = `    if (msg.parent_tool_use_id != null) {
      return;
    }`;
const CLAUDE_CODE_BRIDGE_RESULT_TEXT_PATCH = `    if (msg.parent_tool_use_id != null) {
      return;
    }
    if (type === "result" && msg.subtype === "success") {
      emitAssistantTextFallback(msg.result);
    }`;

/** Group C — AI Gateway model overrides.
 *
 *  Claude Code puts its own native id on the wire (`haiku`, `claude-sonnet-4-5`,
 *  a dated snapshot); the Gateway wants `anthropic/claude-<family>-<major>.<minor>`.
 *  `settings.modelOverrides` bridges that. An Anthropic id OUTSIDE
 *  haiku/sonnet/opus (the evidence table's `unknown` row, which Playground chat
 *  may run with a warning) reaches the bridge as its own slug
 *  (`claude-fable-5`, see `toClaudeCodeModel`) and is overridden to the
 *  provider-qualified Gateway id verbatim (`anthropic/claude-fable-5`) — so the
 *  model on the wire is the model that was asked for, never the CLI default.
 *
 *  The companion `CLAUDE_CODE_EFFORT_LEVEL` write this group used to carry is
 *  GONE from the patch: stable exposes a first-class `env` option on
 *  `createClaudeCode`, so it is passed as configuration instead (see
 *  `createHarness` below). */
const CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_NEEDLE = `var HOST_TOOL_PREFIX = "mcp__harness-tools__";`;
const CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_PATCH = `var HOST_TOOL_PREFIX = "mcp__harness-tools__";
function gatewayModelOverrideSettingsFor(model) {
  if (typeof model !== "string") return undefined;
  let overrides;
  if (model === "haiku") {
    overrides = {
      haiku: "anthropic/claude-haiku-4.5",
      "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
      "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5"
    };
  } else {
    if (!model.startsWith("claude-")) return undefined;
    const match = model.match(/^claude-(haiku|sonnet|opus)-(\\d+)(?:-(\\d+))?$/);
    if (match) {
      const [, family, major, minor] = match;
      overrides = {
        [model]: \`anthropic/claude-\${family}-\${major}\${minor ? \`.\${minor}\` : ""}\`
      };
    } else if (/^claude-[a-z0-9.-]+$/.test(model)) {
      overrides = { [model]: \`anthropic/\${model}\` };
    } else {
      return undefined;
    }
  }
  return { modelOverrides: overrides };
}`;

/** `permissionOptions` is spread LAST into the query options and carries its own
 *  `settings` whenever a permission mode or an inactive native tool produces ask
 *  rules. Injecting `settings` earlier in the literal would be silently clobbered
 *  by that spread, so the overrides are MERGED on top of it here instead. */
const CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_NEEDLE = `      ...permissionOptions,
      mcpServers,
      cwd: workdir,`;
const CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_PATCH = `      ...permissionOptions,
      settings: {
        ...(permissionOptions.settings ?? {}),
        ...(gatewayModelOverrideSettingsFor(start.model) ?? {}),
        ...(process.env.MCPJAM_LOCAL_CONTROL_ROOT ? { permissions: {
          ...(permissionOptions.settings?.permissions ?? {}),
          deny: [...(permissionOptions.settings?.permissions?.deny ?? []),
            ...[process.env.MCPJAM_LOCAL_CONTROL_ROOT,
              ...JSON.parse(process.env.MCPJAM_LOCAL_DENIED_ROOTS || "[]")].flatMap(root => {
                const normalized = root.replaceAll(String.fromCharCode(92), "/").replace(/^([A-Za-z]):/, (_, drive) => "/" + drive.toLowerCase());
                const absolute = "/" + normalized;
                return ["Read(" + absolute + "/**)", "Edit(" + absolute + "/**)"];
              })]
        } } : {}),
      },
      mcpServers,
      cwd: workdir,`;

/* The 1.0.100 bridge moved the turn loop out of createEmitStreamEvent and
 * stopped stamping parent_tool_use_id on its own user messages. Keep a
 * second, deliberately small patch path for that shape. The old path above is
 * still needed for the canary/stable fixture and is left byte-for-byte
 * compatible with it. */
const MODERN_CLAUDE_CODE_BRIDGE_TEXT_STATE_NEEDLE = `  let streamStarted = false;
  const partialBlocks = /* @__PURE__ */ new Map();`;
const MODERN_CLAUDE_CODE_BRIDGE_TEXT_STATE_PATCH = `  let streamStarted = false;
  let streamedAssistantText = false;
  let lastEmittedFallbackText;
  let fallbackTextSeq = 0;
  const emitAssistantTextFallback = (text) => {
    const normalized = typeof text === "string" ? text : "";
    if (!normalized || streamedAssistantText || normalized === lastEmittedFallbackText) return;
    const id = \`mcpjam-fallback-\${Date.now()}-\${++fallbackTextSeq}\`;
    emit({ type: "text-start", id });
    emit({ type: "text-delta", id, delta: normalized });
    emit({ type: "text-end", id });
    lastEmittedFallbackText = normalized;
  };
  const partialBlocks = /* @__PURE__ */ new Map();`;
const MODERN_CLAUDE_CODE_BRIDGE_STREAM_EVENT_NEEDLE = `      if (type === "stream_event") {
        handleStreamEvent(msg.event, partialBlocks, emit);`;
const MODERN_CLAUDE_CODE_BRIDGE_STREAM_EVENT_PATCH = `      if (type === "stream_event") {
        if (msg.event?.type === "content_block_delta" && msg.event?.delta?.type === "text_delta" && typeof msg.event?.delta?.text === "string" && msg.event.delta.text.length > 0) {
          streamedAssistantText = true;
        }
        handleStreamEvent(msg.event, partialBlocks, emit);`;
const MODERN_CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_NEEDLE = `        for (const block of msg.message.content) {
          if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {`;
const MODERN_CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_PATCH = `        for (const block of msg.message.content) {
          if (block.type === "text" && typeof block.text === "string") {
            emitAssistantTextFallback(block.text);
            continue;
          }
          if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {`;
const MODERN_CLAUDE_CODE_BRIDGE_RESULT_TEXT_NEEDLE = `        if (msg.subtype === "success") {
          const emptyResult = !msg.result?.trim?.();`;
const MODERN_CLAUDE_CODE_BRIDGE_RESULT_TEXT_PATCH = `        if (msg.subtype === "success") {
          const emptyResult = !msg.result?.trim?.();
          if (type === "result" && msg.subtype === "success" && !emptyResult) {
            emitAssistantTextFallback(msg.result);
          }`;
const MODERN_CLAUDE_CODE_BRIDGE_USER_MESSAGE_NEEDLE = `  const toUserMessage = (text) => ({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }]
    }
  });`;
const MODERN_CLAUDE_CODE_BRIDGE_USER_MESSAGE_PATCH = `  const toUserMessage = (text) => ({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }]
    },
    parent_tool_use_id: null
  });`;
const MODERN_CLAUDE_CODE_BRIDGE_MODEL_HELPER_NEEDLE = `  const q = claudeSdk.query({`;
const MODERN_CLAUDE_CODE_BRIDGE_MODEL_HELPER_PATCH = `  function gatewayModelOverrideSettingsFor(model) {
    if (typeof model !== "string") return undefined;
    let overrides;
    if (model === "haiku") {
      overrides = {
        haiku: "anthropic/claude-haiku-4.5",
        "claude-haiku-4-5": "anthropic/claude-haiku-4.5",
        "claude-haiku-4-5-20251001": "anthropic/claude-haiku-4.5"
      };
    } else {
      if (!model.startsWith("claude-")) return undefined;
      const match = model.match(/^claude-(haiku|sonnet|opus)-(\\d+)(?:-(\\d+))?$/);
      if (match) {
        const [, family, major, minor] = match;
        overrides = {
          [model]: \`anthropic/claude-\${family}-\${major}\${minor ? \`.\${minor}\` : ""}\`
        };
      } else if (/^claude-[a-z0-9.-]+$/.test(model)) {
        overrides = { [model]: \`anthropic/\${model}\` };
      } else {
        return undefined;
      }
    }
    return { modelOverrides: overrides };
  }
  const q = claudeSdk.query({`;

function patchModernClaudeCodeBridgeContent(content: string): string {
  let patched = content;
  const replacements = [
    [
      MODERN_CLAUDE_CODE_BRIDGE_TEXT_STATE_NEEDLE,
      MODERN_CLAUDE_CODE_BRIDGE_TEXT_STATE_PATCH,
    ],
    [
      MODERN_CLAUDE_CODE_BRIDGE_STREAM_EVENT_NEEDLE,
      MODERN_CLAUDE_CODE_BRIDGE_STREAM_EVENT_PATCH,
    ],
    [
      MODERN_CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_NEEDLE,
      MODERN_CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_PATCH,
    ],
    [
      MODERN_CLAUDE_CODE_BRIDGE_RESULT_TEXT_NEEDLE,
      MODERN_CLAUDE_CODE_BRIDGE_RESULT_TEXT_PATCH,
    ],
    [
      MODERN_CLAUDE_CODE_BRIDGE_USER_MESSAGE_NEEDLE,
      MODERN_CLAUDE_CODE_BRIDGE_USER_MESSAGE_PATCH,
    ],
    [
      MODERN_CLAUDE_CODE_BRIDGE_MODEL_HELPER_NEEDLE,
      MODERN_CLAUDE_CODE_BRIDGE_MODEL_HELPER_PATCH,
    ],
    [
      CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_NEEDLE,
      CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_PATCH,
    ],
  ] as const;

  for (const [needle, replacement] of replacements) {
    if (!patched.includes(needle)) {
      throw new Error(
        "Unable to patch Claude Code bridge bootstrap: modern bridge shape changed",
      );
    }
    patched = patched.replace(needle, replacement);
  }

  return patched;
}

/**
 * Keep the product's MCP selection authoritative even in a user's workspace.
 * Apply independently of the other patches so already-patched recipes upgrade.
 */
function enforceStrictMcpConfig(content: string): string {
  const needle = "      mcpServers,\n      cwd: workdir,";
  const replacement =
    "      mcpServers,\n      strictMcpConfig: true,\n      cwd: workdir,";
  if (content.includes(replacement)) return content;
  if (!content.includes(needle)) {
    throw new Error(
      "Unable to patch Claude Code bridge bootstrap: MCP query options shape changed",
    );
  }
  return content.replace(needle, replacement);
}

function patchClaudeCodeBridgeContent(content: string): string {
  let patched = content;

  // Route the CANARY line to its own anchor set. Despite the name, the
  // `MODERN_*` group below is the canary one: the stable-line anchors are the
  // `CLAUDE_CODE_BRIDGE_*` group above, and those are what 1.0.100 matches.
  //
  // The discriminator is the stream-event call shape — canary passes its
  // arguments positionally, stable passes a single object. `mcpToolUseIds` and
  // a `const partialBlocks` binding, which used to gate this, are present on
  // BOTH lines (stable's reads `state.partialBlocks`), so the pair never
  // discriminated: every bridge took the canary branch and the stable anchors
  // were unreachable, which is why a `npm ci` install of the pinned 1.0.100
  // threw "modern bridge shape changed" while a stale canary node_modules
  // passed.
  if (patched.includes("handleStreamEvent(msg.event,")) {
    return patchModernClaudeCodeBridgeContent(patched);
  }

  if (!patched.includes("emitAssistantTextFallback")) {
    for (const [needle, replacement] of [
      [
        CLAUDE_CODE_BRIDGE_TEXT_STATE_NEEDLE,
        CLAUDE_CODE_BRIDGE_TEXT_STATE_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_STREAM_EVENT_NEEDLE,
        CLAUDE_CODE_BRIDGE_STREAM_EVENT_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_NEEDLE,
        CLAUDE_CODE_BRIDGE_ASSISTANT_TEXT_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_RESULT_TEXT_NEEDLE,
        CLAUDE_CODE_BRIDGE_RESULT_TEXT_PATCH,
      ],
    ] as const) {
      if (!patched.includes(needle)) {
        throw new Error(
          "Unable to patch Claude Code bridge bootstrap: assistant text shape changed",
        );
      }
      patched = patched.replace(needle, replacement);
    }
  }

  if (!patched.includes("gatewayModelOverrideSettingsFor")) {
    for (const [needle, replacement] of [
      [
        CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_NEEDLE,
        CLAUDE_CODE_BRIDGE_MODEL_OVERRIDES_PATCH,
      ],
      [
        CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_NEEDLE,
        CLAUDE_CODE_BRIDGE_QUERY_OPTIONS_PATCH,
      ],
    ] as const) {
      if (!patched.includes(needle)) {
        throw new Error(
          "Unable to patch Claude Code bridge bootstrap: model override shape changed",
        );
      }
      patched = patched.replace(needle, replacement);
    }
  }

  // Group D: the turn stays open until its background agents report back.
  // After Group B, whose result fallback it extends.
  patched = patchClaudeCodeBackgroundDrain(patched);

  // Group E: a subagent's tool calls reach the UI as raw parts, never the
  // transcript. Inside the sub-agent guard, which still returns.
  patched = patchClaudeCodeSubagentSteps(patched);

  /* The adapter now sets `parent_tool_use_id` itself. If a future version drops
   * it again the sub-agent guard silently stops filtering, so fail loudly
   * rather than let a subagent's stream merge into the parent transcript. */
  if (!patched.includes("parent_tool_use_id")) {
    throw new Error(
      "Unable to verify Claude Code bridge bootstrap: user-message shape changed",
    );
  }

  return patched;
}

/**
 * Config written beside the adapter's bundled manifest so its `pnpm install`
 * can install a working Claude Code CLI.
 *
 * WHY THIS EXISTS. `@anthropic-ai/claude-code` ships a `postinstall`
 * (`node install.cjs`) that fetches its platform-native binary; without it the
 * CLI starts and immediately reports `claude native binary not installed`.
 * pnpm 10 stopped running dependency build scripts by default, and the
 * computer template installs pnpm UNPINNED (`npm install -g pnpm`), so a
 * rebuilt image changes behaviour with whatever pnpm is current.
 *
 * TWO INDEPENDENT LAYERS, because the first one is a moving target:
 *
 *   1. ALLOW the build to run, so the postinstall happens normally.
 *   2. Failing that, do not let a SKIPPED build be FATAL. The adapter's own
 *      recipe re-runs `install.cjs` by hand after the install — but that
 *      rescue only fires when the install step exits zero. Turning
 *      `ERR_PNPM_IGNORED_BUILDS` back into a warning is what lets the
 *      adapter repair itself.
 *
 * Layer 2 is the durable one. It survives a rename of the allow-list setting,
 * which has already happened once: the first version of this patch shipped
 * only `.npmrc`, verified against pnpm 10 — and pnpm 11 reads none of its
 * settings from `.npmrc`, so it broke every harness bootstrap the moment the
 * recipe hash changed and snapshots stopped hiding it.
 *
 * WHAT CHANGED AT THE STABLE BUMP. Newer `@ai-sdk/harness-claude-code@1.0.x`
 * releases may ship their OWN `pnpm-workspace.yaml`, pinning the build it
 * needs by exact version (`allowBuilds: { '@anthropic-ai/claude-code@<v>':
 * true }`). Older/newly rebuilt adapters may omit it, so
 * {@link patchClaudeCodeHarnessBootstrap} adds an equivalent version-pinned
 * file from the bundled manifest and falls back to bounded compatibility
 * settings only when that manifest cannot be read. The adapter may also keep
 * a conditional `install.cjs` rescue in its recipe; we leave that command
 * intact and verify it still ends with `claude --version`.
 *
 * `.npmrc` STAYS. pnpm 10 does not read `allowBuilds` from
 * `pnpm-workspace.yaml`, and the computer template installs pnpm UNPINNED
 * (`npm install -g pnpm`), so a box that has not been rebuilt still resolves
 * pnpm 10 and still needs the `.npmrc` spelling. Verified against pnpm 10.34.5
 * and 11.24.0.
 *
 * WHY NOT THE MANIFEST. `onlyBuiltDependencies` would be narrower, but the
 * manifest is a bundled asset of `@ai-sdk/harness-claude-code`, not ours to
 * amend, and editing it would invalidate the `--frozen-lockfile` the adapter
 * installs with. It also does not work here: pnpm 11 ignored it under `--dir`
 * in testing, while the settings below took effect.
 *
 * The permissiveness is bounded by where it lands: one directory inside a
 * disposable sandbox that already runs an agent with full shell access.
 */
const CLAUDE_CODE_BOOTSTRAP_NPMRC =
  "dangerously-allow-all-builds=true\nstrict-dep-builds=false\n";

/** pnpm 11's home for the same two settings, written ONLY as a fallback for a
 *  future adapter that stops shipping its own; see
 *  {@link CLAUDE_CODE_BOOTSTRAP_NPMRC}. */
const CLAUDE_CODE_BOOTSTRAP_PNPM_WORKSPACE =
  "dangerouslyAllowAllBuilds: true\nstrictDepBuilds: false\n";

function pnpmWorkspaceForClaudeCodeBootstrap(
  files: Awaited<
    ReturnType<NonNullable<HarnessAgentAdapter["getBootstrap"]>>
  >["files"],
): string {
  const packageFile = files.find((file) => file.path.endsWith("/package.json"));
  if (packageFile) {
    try {
      const pkg = JSON.parse(packageFile.content) as {
        dependencies?: Record<string, unknown>;
      };
      const version = pkg.dependencies?.["@anthropic-ai/claude-code"];
      if (
        typeof version === "string" &&
        /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
      ) {
        return `allowBuilds:\n  '@anthropic-ai/claude-code@${version}': true\n`;
      }
    } catch {
      // Fall through to the bounded compatibility fallback below.
    }
  }
  return CLAUDE_CODE_BOOTSTRAP_PNPM_WORKSPACE;
}

export function patchClaudeCodeHarnessBootstrap(
  harness: HarnessAgentAdapter,
): HarnessAgentAdapter {
  const originalGetBootstrap = harness.getBootstrap?.bind(harness);
  if (!originalGetBootstrap) return harness;

  let cachedPatchedBootstrap:
    | Awaited<ReturnType<NonNullable<typeof originalGetBootstrap>>>
    | undefined;

  return {
    ...harness,
    getBootstrap: async (...args) => {
      if (cachedPatchedBootstrap) return cachedPatchedBootstrap;
      const bootstrap = await originalGetBootstrap(...args);
      // The adapter ships its own version-pinned `pnpm-workspace.yaml` since
      // the stable line. Appending a second entry for the same path would write
      // the file twice with conflicting content, so ours is a FALLBACK: it is
      // added only if the adapter stops shipping one. `.npmrc` is always ours —
      // the adapter ships none, and pnpm 10 reads nothing else.
      const shipsPnpmWorkspace = bootstrap.files.some((file) =>
        file.path.endsWith("/pnpm-workspace.yaml"),
      );
      cachedPatchedBootstrap = {
        ...bootstrap,
        files: [
          ...bootstrap.files.map((file) =>
            file.path.endsWith("/bridge.mjs")
              ? {
                  ...file,
                  content: enforceStrictMcpConfig(
                    patchClaudeCodeBridgeContent(file.content),
                  ),
                }
              : file,
          ),
          {
            path: `${bootstrap.bootstrapDir}/.npmrc`,
            content: CLAUDE_CODE_BOOTSTRAP_NPMRC,
          },
          ...(shipsPnpmWorkspace
            ? []
            : [
                {
                  path: `${bootstrap.bootstrapDir}/pnpm-workspace.yaml`,
                  content: pnpmWorkspaceForClaudeCodeBootstrap(bootstrap.files),
                },
              ]),
        ],
      };
      return cachedPatchedBootstrap;
    },
  };
}

