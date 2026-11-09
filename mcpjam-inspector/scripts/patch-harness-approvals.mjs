import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

function replaceOnce(source, before, after) {
  if (source.includes(after)) {
    if (
      source.split(after).length !== 2 ||
      source.replace(after, "").includes(before)
    )
      throw new Error("The harness approval patch has ambiguous anchors.");
    return source;
  }
  if (source.split(before).length !== 2)
    throw new Error(
      "The harness approval patch no longer matches. Requalify the runtime before updating it.",
    );
  return source.replace(before, after);
}

/** Keep the driver's consumed-event cursor and approved native calls coherent. */
export function patchAgent(source) {
  const replacements = [
    [
      "const reader = stream.getReader();",
      "const reader = stream.getReader();\n\t\tlet lastConsumedEvent;",
    ],
    [
      "const pauseForHostInput = async (finishStep) => {",
      "const pauseForHostInput = async (finishStep, checkpoint = finishStep) => {\n\t\t\tpinSandboxChannelEventCheckpoint(checkpoint);",
    ],
    [
      "await pauseForHostInput(deferredPauseFinishStep);\n\t\t\t\t\treturn;",
      "await pauseForHostInput(deferredPauseFinishStep, lastConsumedEvent);\n\t\t\t\t\treturn;",
    ],
    [
      'if (value == null) continue;\n\t\t\t\tif (value.type === "raw")',
      'if (value == null) continue;\n\t\t\t\tlastConsumedEvent = value;\n\t\t\t\tif (value.type === "raw")',
    ],
    [
      "\t\t\t\tawait control.submitToolApproval({\n\t\t\t\t\tapprovalId: approval.approvalId,",
      "\t\t\t\tif (continuation.approved) hostToolCallIdsAwaitingEcho.add(approval.toolCallId);\n\t\t\t\tawait control.submitToolApproval({\n\t\t\t\t\tapprovalId: approval.approvalId,",
    ],
    [
      'if (value.type === "finish") {\n\t\t\t\t\tif (hostInputPauseRequested)',
      'if (value.type === "finish") {\n\t\t\t\t\tif (hostToolCallIdsAwaitingEcho.size > 0) throw new Error("The runtime ended before approved tool results arrived.");\n\t\t\t\t\tif (hostInputPauseRequested)',
    ],
    [
      "\t\t\tif (hostInputPauseRequested && input.isTurnSuspending?.() !== true) {",
      '\t\t\tif (hostToolCallIdsAwaitingEcho.size > 0 && input.isTurnSuspending?.() !== true) throw new Error("The runtime ended before approved tool results arrived.");\n\t\t\tif (hostInputPauseRequested && input.isTurnSuspending?.() !== true) {',
    ],
  ];
  replacements.push(["const settledBuiltinApprovalToolCallIds = /* @__PURE__ */ new Set();", "const settledBuiltinApprovalToolCallIds = /* @__PURE__ */ new Set();\n\t\tconst consumedApprovedHostRelays = new Set();"]);
  replacements.push(["const settledBuiltinApprovalReplay = (displayValue.type === \"tool-call\" || displayValue.type === \"tool-approval-request\") && settledBuiltinApprovalToolCallIds.has(displayValue.toolCallId);", "const approvedHostRelay = displayValue.type === \"tool-call\" && displayValue.providerExecuted === false && displayValue.providerMetadata?.mcpjam?.approvedHostToolCallId === displayValue.toolCallId && settledBuiltinApprovalToolCallIds.has(displayValue.toolCallId) && !consumedApprovedHostRelays.has(displayValue.toolCallId);\n\t\t\t\tif (approvedHostRelay) consumedApprovedHostRelays.add(displayValue.toolCallId);\n\t\t\t\tconst settledBuiltinApprovalReplay = (displayValue.type === \"tool-call\" || displayValue.type === \"tool-approval-request\") && settledBuiltinApprovalToolCallIds.has(displayValue.toolCallId) && !approvedHostRelay;"]);
  for (const [before, after] of replacements)
    source = replaceOnce(source, before, after);
  return source;
}

/** Dynamic MCP events must retain the channel's non-enumerable checkpoint. */
export function patchAcp(source) {
  source = replaceOnce(
    source,
    "forward(dynamicToolCalls.get(event.toolCallId) === true ? {\n\t\t\t\t...event,\n\t\t\t\tdynamic: true\n\t\t\t} : event);",
    "forward(dynamicToolCalls.get(event.toolCallId) === true ? Object.assign(Object.create(Object.getPrototypeOf(event), Object.getOwnPropertyDescriptors(event)), { dynamic: true }) : event);",
  );
  return replaceOnce(
    source,
    "forward(dynamic ? {\n\t\t\t\t...event,\n\t\t\t\tdynamic: true\n\t\t\t} : event);",
    "forward(dynamic ? Object.assign(Object.create(Object.getPrototypeOf(event), Object.getOwnPropertyDescriptors(event)), { dynamic: true }) : event);",
  );
}

export default function installApprovalPatch() {
  const require = createRequire(import.meta.url);
  for (const [name, version, relativePath, patch] of [
    ["@ai-sdk/harness", "1.0.158", "dist/agent/index.js", patchAgent],
    ["@ai-sdk/harness-acp", "1.0.97", "dist/index.js", patchAcp],
  ]) {
    const manifest = require.resolve(`${name}/package.json`);
    if (JSON.parse(readFileSync(manifest, "utf8")).version !== version)
      throw new Error(
        `Requalify the ${name} approval patch before changing its version.`,
      );
    const path = join(dirname(manifest), relativePath);
    const original = readFileSync(path, "utf8");
    const next = patch(original);
    if (next !== original) writeFileSync(path, next);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  installApprovalPatch();
