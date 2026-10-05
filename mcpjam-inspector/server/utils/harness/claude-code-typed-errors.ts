/**
 * HOSTED Claude Code: typed terminal errors (eval infra-error classification).
 *
 * The bridge already SEES the structured facts a model-provider failure
 * carries — `api_retry.error_status` (the upstream HTTP status Claude Code is
 * retrying) and the SDK's typed assistant `error` category (`rate_limit`,
 * `server_error`, `authentication_failed`, `billing_error`, …) — and then
 * throws them away: `emitTerminalError` sends a bare sentence, which the
 * harness wire carries as `error: unknown` and the host can only read as
 * prose. An eval then scores a provider 529 against the customer's server.
 *
 * This patch keeps the last model-call evidence on the turn's own stream
 * state, clears it whenever the model call SUCCEEDS again (so a recovered
 * retry cannot label a later, unrelated failure), and sends a plain
 * `HarnessProviderError` object instead of the sentence when — and only when —
 * structured evidence exists (`harness-provider-error.ts`). No evidence: the
 * bridge sends exactly what it sent before.
 *
 * WHY A SEPARATE MODULE, applied only by the registry's hosted adapter:
 * `claude-code-bootstrap.ts` and the bridge bytes it emits are LOCAL RUNTIME
 * PACK inputs (`scripts/check-local-harness-inputs.mjs`). Editing them would
 * force re-publishing the signed local packs before any release. A local
 * session never runs this recipe anyway — `withLocalPackBootstrap` replaces
 * `getBootstrap` with the verified pack's own — so the hosted (E2B) recipe is
 * the only one that changes.
 *
 * NOT all-or-nothing-throws like the bootstrap patches: a missing anchor
 * leaves the bridge untyped (failures stay unclassified, the safe direction)
 * and `registry.test.ts` asserts the PINNED bridge takes the patch, so a
 * version bump that moves an anchor fails CI loudly instead of breaking every
 * hosted turn.
 */
import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";
import { createClaudeCodeHarness } from "./claude-code-bootstrap.js";

const TYPED_ERRORS_MARKER = "mcpjamTypedTerminalError";
const TYPED_ERRORS_HELPERS = `var MCPJAM_CC_TYPED_ERROR_CATEGORIES = /* @__PURE__ */ new Set(["rate_limit", "server_error", "authentication_failed", "billing_error", "overloaded"]);
function mcpjamObserveModelCall(state, msg) {
  if (!state || !msg) return;
  if (msg.type === "system" && msg.subtype === "api_retry") {
    state.mcpjamApiErrorStatus = typeof msg.error_status === "number" ? msg.error_status : void 0;
    state.mcpjamApiErrorCategory = typeof msg.error === "string" ? msg.error : void 0;
  } else if (msg.type === "assistant" && msg.parent_tool_use_id == null) {
    if (typeof msg.error === "string" && msg.error) {
      state.mcpjamApiErrorCategory = msg.error;
    } else {
      state.mcpjamApiErrorStatus = void 0;
      state.mcpjamApiErrorCategory = void 0;
    }
  } else if (msg.type === "stream_event" && msg.parent_tool_use_id == null) {
    state.mcpjamApiErrorStatus = void 0;
    state.mcpjamApiErrorCategory = void 0;
  }
}
function ${TYPED_ERRORS_MARKER}(message, state) {
  const httpStatus = typeof state?.mcpjamApiErrorStatus === "number" ? state.mcpjamApiErrorStatus : void 0;
  const category = typeof state?.mcpjamApiErrorCategory === "string" && MCPJAM_CC_TYPED_ERROR_CATEGORIES.has(state.mcpjamApiErrorCategory) ? state.mcpjamApiErrorCategory : void 0;
  if (httpStatus === void 0 && category === void 0) return message;
  return {
    name: "HarnessProviderError",
    message,
    source: "model",
    ...category ? { code: "claude_code_" + category } : {},
    ...httpStatus !== void 0 ? { httpStatus } : {}
  };
}
`;

/** True when `content` already carries the typed-terminal-error patch. */
export function claudeCodeBridgeHasTypedErrors(content: string): boolean {
  return content.includes(`function ${TYPED_ERRORS_MARKER}(`);
}

/** Apply the patch to bridge source, or return it unchanged if any anchor moved. */
export function typeClaudeCodeTerminalErrors(content: string): string {
  if (claudeCodeBridgeHasTypedErrors(content)) return content;
  const helperAnchor = /^var UNRECOVERABLE_API_RETRY_STATUSES = [^\n]*;$/m;
  const apiRetryAnchor =
    /^([ \t]*)if \(type === "system" && msg\.subtype === "api_retry"\) \{$/m;
  const errorCaptureAnchor =
    /^([ \t]*)if \(typeof msg\.error === "string" && msg\.error\.trim\(\)\) \{\n[ \t]*state\.observedTerminalError = msg\.error\.trim\(\);$/m;
  const emitAnchor =
    /error: normalized,(\s*)message: "claude-code terminal error"/;
  if (
    !helperAnchor.test(content) ||
    !apiRetryAnchor.test(content) ||
    !errorCaptureAnchor.test(content) ||
    !emitAnchor.test(content) ||
    !content.includes("streamEventState")
  ) {
    return content;
  }
  return content
    .replace(helperAnchor, (line) => `${line}\n${TYPED_ERRORS_HELPERS}`)
    .replace(
      apiRetryAnchor,
      (line, indent: string) =>
        `${line}\n${indent}  mcpjamObserveModelCall(state, msg);`,
    )
    .replace(
      errorCaptureAnchor,
      (block, indent: string) =>
        `${indent}mcpjamObserveModelCall(state, msg);\n${block}`,
    )
    .replace(
      emitAnchor,
      (_match, gap: string) =>
        `error: ${TYPED_ERRORS_MARKER}(normalized, streamEventState),${gap}message: "claude-code terminal error"`,
    );
}

/** Wrap an adapter so its emitted `bridge.mjs` carries typed terminal errors. */
export function withClaudeCodeTypedTerminalErrors(
  harness: HarnessAgentAdapter,
): HarnessAgentAdapter {
  const originalGetBootstrap = harness.getBootstrap?.bind(harness);
  if (!originalGetBootstrap) return harness;
  let cached:
    | Awaited<ReturnType<NonNullable<typeof originalGetBootstrap>>>
    | undefined;
  return {
    ...harness,
    getBootstrap: async (...args) => {
      if (cached) return cached;
      const bootstrap = await originalGetBootstrap(...args);
      cached = {
        ...bootstrap,
        files: bootstrap.files.map((file) =>
          file.path.endsWith("/bridge.mjs")
            ? { ...file, content: typeClaudeCodeTerminalErrors(file.content) }
            : file,
        ),
      };
      return cached;
    },
  };
}

/**
 * The Claude Code adapter HOSTED runs use: the shared bootstrap
 * (`createClaudeCodeHarness`) plus typed terminal errors. The recipe — and so
 * its bootstrap identity — is what an E2B box installs or finds baked.
 */
export function createHostedClaudeCodeHarness(
  settings?: Parameters<typeof createClaudeCodeHarness>[0],
): HarnessAgentAdapter {
  return withClaudeCodeTypedTerminalErrors(createClaudeCodeHarness(settings));
}
