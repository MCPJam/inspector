/**
 * Group E: a subagent's steps, for the Claude Code bridge.
 *
 * The vendored bridge (`@ai-sdk/harness-claude-code@1.0.121`,
 * `dist/bridge/index.mjs`) drops every message a subagent produces: its
 * `parent_tool_use_id` guard returns before the `assistant` and `user`
 * branches, so a subagent's tool calls never reach the turn. That is right for
 * the transcript (the subagent's work is not the main thread's, and its final
 * report already arrives as the Agent call's own result) but it leaves the
 * user watching a collapsed `Agent` card for as long as the subagent runs.
 *
 * This patch forwards what the CLI already sends for a subagent by default
 * (its `tool_use` and `tool_result` blocks; its text only arrives with
 * `forwardSubagentText`, which the bridge leaves off) as `raw` parts:
 *
 *   { mcpjam: "subagent-step", kind: "tool-call", rootToolUseId,
 *     parentToolUseId, toolUseId, toolName, input? }
 *   { mcpjam: "subagent-step", kind: "tool-result", rootToolUseId,
 *     parentToolUseId, toolUseId, isError, error? }
 *
 * `rootToolUseId` is the main-thread Agent call the work belongs to, followed
 * up through nested subagents, so the client can attach every step to the one
 * card it has. Inputs keep scalar fields only, strings cut to 300 characters:
 * a step is a label, not a transcript, and a `Write`'s content or a `Read`'s
 * result would otherwise ride the stream whole. Results carry no output, only
 * whether they failed (and the start of the error).
 *
 * A raw part never enters the model's history or the saved transcript (the
 * agent does not accumulate it, and the server turns it into a transient UI
 * chunk), and it does not open the bridge's step. The guard still returns
 * after forwarding, so nothing else about a subagent's messages changes.
 */

/** Present once Group E is applied; also the bake sentinel. */
export const CLAUDE_CODE_SUBAGENT_STEPS_MARKER = "mcpjamForwardSubagentStep";

const BLOCK_BEGIN = "/* mcpjam-subagent-steps:begin */";
const BLOCK_END = "/* mcpjam-subagent-steps:end */";

/**
 * Module-level helpers, inserted ahead of the bridge's `addUsage`.
 * Self-contained between the begin/end comments, so the tests can lift them
 * out of the installed, patched bridge with `new Function`.
 *
 * Plain JavaScript in a template literal: no backticks, no `${`.
 */
const STEP_HELPERS = `${BLOCK_BEGIN}
var MCPJAM_SUBAGENT_STEP_STRING_MAX = 300;
var MCPJAM_SUBAGENT_STEP_FIELDS_MAX = 8;
var MCPJAM_SUBAGENT_DEPTH_MAX = 16;
function mcpjamSubagentStepText(value) {
  return value.length > MCPJAM_SUBAGENT_STEP_STRING_MAX ? value.slice(0, MCPJAM_SUBAGENT_STEP_STRING_MAX) + "\\u2026" : value;
}
function mcpjamSubagentStepInput(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) return void 0;
  const out = {};
  let fields = 0;
  for (const [key, value] of Object.entries(input)) {
    if (fields >= MCPJAM_SUBAGENT_STEP_FIELDS_MAX) break;
    if (typeof value === "string") out[key] = mcpjamSubagentStepText(value);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else continue;
    fields++;
  }
  return out;
}
function mcpjamSubagentStepError(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") text += block.text;
    }
  }
  text = text.trim();
  return text ? mcpjamSubagentStepText(text) : void 0;
}
function mcpjamSubagentRoot(parents, toolUseId) {
  let root = toolUseId;
  for (let depth = 0; depth < MCPJAM_SUBAGENT_DEPTH_MAX; depth++) {
    const parent = parents.get(root);
    if (parent === void 0) break;
    root = parent;
  }
  return root;
}
function mcpjamForwardSubagentStep(state, emit, msg) {
  const parentToolUseId = msg?.parent_tool_use_id;
  if (typeof parentToolUseId !== "string" || parentToolUseId.length === 0) return;
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  if (!state.mcpjamSubagentParents) state.mcpjamSubagentParents = /* @__PURE__ */ new Map();
  const parents = state.mcpjamSubagentParents;
  const rootToolUseId = mcpjamSubagentRoot(parents, parentToolUseId);
  if (msg.type === "assistant") {
    for (const block of content) {
      if (block?.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") continue;
      parents.set(block.id, parentToolUseId);
      const input = mcpjamSubagentStepInput(block.input);
      emit({
        type: "raw",
        rawValue: {
          mcpjam: "subagent-step",
          kind: "tool-call",
          rootToolUseId,
          parentToolUseId,
          toolUseId: block.id,
          toolName: block.name,
          ...input !== void 0 ? { input } : {}
        }
      });
    }
  } else if (msg.type === "user") {
    for (const block of content) {
      if (block?.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const isError = block.is_error === true;
      const error = isError ? mcpjamSubagentStepError(block.content) : void 0;
      emit({
        type: "raw",
        rawValue: {
          mcpjam: "subagent-step",
          kind: "tool-result",
          rootToolUseId,
          parentToolUseId,
          toolUseId: block.tool_use_id,
          isError,
          ...error !== void 0 ? { error } : {}
        }
      });
    }
  }
}
${BLOCK_END}
`;

type Replacement = readonly [needle: string, replacement: string];

const REPLACEMENTS: readonly Replacement[] = [
  // Module helpers.
  [
    `function addUsage(total, usage) {
  if (total == null) return usage;`,
    `${STEP_HELPERS}function addUsage(total, usage) {
  if (total == null) return usage;`,
  ],
  // The sub-agent guard: forward the step, then return as before.
  [
    `    if (msg.parent_tool_use_id != null) {
      return;
    }`,
    `    if (msg.parent_tool_use_id != null) {
      mcpjamForwardSubagentStep(state, emit, msg);
      return;
    }`,
  ],
];

/** Every needle Group E matches, for fixtures that must quote them. */
export const CLAUDE_CODE_SUBAGENT_STEPS_NEEDLES: readonly string[] =
  REPLACEMENTS.map(([needle]) => needle);

/**
 * Apply Group E. Idempotent on {@link CLAUDE_CODE_SUBAGENT_STEPS_MARKER};
 * throws on any missing or ambiguous needle rather than ship a guard that
 * silently stopped filtering.
 */
export function patchClaudeCodeSubagentSteps(content: string): string {
  if (content.includes(CLAUDE_CODE_SUBAGENT_STEPS_MARKER)) return content;
  let patched = content;
  for (const [needle, replacement] of REPLACEMENTS) {
    const at = patched.indexOf(needle);
    if (at < 0 || patched.indexOf(needle, at + needle.length) >= 0) {
      throw new Error(
        "Unable to patch Claude Code bridge bootstrap: sub-agent guard shape changed",
      );
    }
    patched =
      patched.slice(0, at) + replacement + patched.slice(at + needle.length);
  }
  return patched;
}

/**
 * The self-contained helper block of a patched bridge, for tests that lift
 * the forwarder out of the INSTALLED bridge.
 */
export function extractClaudeCodeSubagentStepHelpers(
  content: string,
): string | undefined {
  const begin = content.indexOf(BLOCK_BEGIN);
  const end = content.indexOf(BLOCK_END);
  if (begin < 0 || end < begin) return undefined;
  return content.slice(begin, end + BLOCK_END.length);
}
