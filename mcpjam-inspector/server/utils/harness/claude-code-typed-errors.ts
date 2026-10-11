/**
 * HOSTED Claude Code: typed terminal errors for the eval infra classifier.
 *
 * The bridge sees a model-call failure's structured facts — `api_retry`'s
 * upstream `error_status` and the SDK's assistant `error` category — but sends
 * only a sentence. This patch keeps the last model-call evidence on the turn's
 * stream state (cleared whenever a call succeeds again) and sends a plain
 * `HarnessProviderError` object (`harness-provider-error.ts`) when, and only
 * when, such evidence exists.
 *
 * Applied only by the registry's hosted adapter: the shared bootstrap is a
 * local runtime pack input (`scripts/check-local-harness-inputs.mjs`), and a
 * local session swaps in its pack's own bootstrap. A moved anchor leaves the
 * bridge untyped (the safe direction); `registry.test.ts` pins that the pinned
 * bridge takes the patch.
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
    Awaited<ReturnType<NonNullable<typeof originalGetBootstrap>>> | undefined;
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
 * (`createClaudeCodeHarness`) plus typed terminal errors. This recipe is the
 * bridge an E2B box installs.
 */
export function createHostedClaudeCodeHarness(
  settings?: Parameters<typeof createClaudeCodeHarness>[0],
): HarnessAgentAdapter {
  return withClaudeCodeTypedTerminalErrors(createClaudeCodeHarness(settings));
}
