import type { HarnessAgentAdapter } from "@ai-sdk/harness/agent";

/** Patch only the pinned ACP bridge; changed vendor code must be requalified. */
export function patchCursorHostToolApproval(source: string): string {
  source = replaceInRegion(source, "src/v1/bridge/permission-controller.ts", `if (call != null) {`, `if (call != null && permissionMode === "allow-all") {`);
  source = replaceInRegion(source, "src/v1/bridge/permission-controller.ts", `if (!hasPermissionModeMapping && shouldAutoApprove({`, `if (call == null && !hasPermissionModeMapping && shouldAutoApprove({`);
  source = replaceInRegion(source, "src/v1/bridge/permission-controller.ts", `if (response == null) return cancelled();`, `if (response == null) return cancelled();
				if (response.approved && call != null) onHostToolPermissionAllowed?.({ toolCallId: request.toolCall.toolCallId, call });`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay-authorization.ts", `if (call == null) {`, `if (call == null || permissionCall == null) {`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay-authorization.ts", `pending.resolve(true);`, `pending.resolve(toolCallId);`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay-authorization.ts", `return Promise.resolve(true);`, `return Promise.resolve(toolCallId);`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `if (!await turn.waitForToolCallAuthorization({
		toolName: tool.name,
		input: body.input
	})) throw new RelayRequestError({`, `const authorizedToolCallId = await turn.waitForToolCallAuthorization({
		toolName: tool.name,
		input: body.input
	});
	if (typeof authorizedToolCallId !== "string") throw new RelayRequestError({`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `toolCallId: body.requestId,
		toolName: tool.name,
		input: body.input`, `toolCallId: authorizedToolCallId,
		approvedHostToolCallId: authorizedToolCallId,
		toolName: tool.name,
		input: body.input`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `turn.requestToolResult(body.requestId)`, `turn.requestToolResult(authorizedToolCallId)`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `toolCallId: body.requestId,
		toolName: tool.name,
		output: result.output`, `toolCallId: authorizedToolCallId,
		toolName: tool.name,
		output: result.output`);
  source = replaceInRegion(source, "src/v1/bridge/index.ts", `const mcpTransport = bridgeConfiguration.hostToolMcpTransport ?? "stdio";`, `const mcpTransport = bridgeConfiguration.hostToolMcpTransport ?? "http";`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-mcp-server.ts", `async (request) => {`, `async (request, extra) => {`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-mcp-server.ts", `catalogRevision: current.revision
		})`, `catalogRevision: current.revision, signal: extra.signal
		})`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `invoke: ({ toolName, input, catalogRevision }) => handleInvocation({`, `invoke: ({ toolName, input, catalogRevision, signal }) => handleInvocation({
			signal,`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `async function handleInvocation({ body, state, serverName, nonTextContentTypes, turn, nextInvocationOrder }) {`, `async function handleInvocation({ body, state, serverName, nonTextContentTypes, turn, nextInvocationOrder, signal }) {
	signal?.throwIfAborted();`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `const correlationToken = randomBytes(32).toString("hex");`, `signal?.throwIfAborted();
	const onCancelled = () => turn.cancelToolCall?.(authorizedToolCallId);
	signal?.addEventListener("abort", onCancelled, { once: true });
	const correlationToken = randomBytes(32).toString("hex");`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `
	let toolResult = result.toolResult;`, `
	signal?.removeEventListener("abort", onCancelled);
	signal?.throwIfAborted();
	let toolResult = result.toolResult;`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay.ts", `turn.removeCorrelationInvocation({ token: correlationToken });
		throw error;`, `signal?.removeEventListener("abort", onCancelled);
		turn.removeCorrelationInvocation({ token: correlationToken });
		throw error;`);
  source = replaceInRegion(source, "src/v1/bridge/index.ts", `emitWarning: turn.emitWarning,
		requestToolResult:`, `emitWarning: turn.emitWarning,
		cancelToolCall: (toolCallId) => turn.emit({ type: "raw", rawValue: { type: "mcpjam-host-tool-cancel", toolCallId } }),
		requestToolResult:`);
  source = replaceInRegion(source, "src/v1/bridge/stream-translator.ts", `const hostToolCall = ({ toolCallId, toolName, input }) => {`, `const hostToolCall = ({ toolCallId, toolName, input, approvedHostToolCallId }) => {`);
  source = replaceInRegion(source, "src/v1/bridge/stream-translator.ts", `providerExecuted: false
		});`, `providerExecuted: false,
			...(approvedHostToolCallId ? { harnessMetadata: { mcpjam: { approvedHostToolCallId } } } : {})
		});`);
  source = replaceInRegion(source, "src/v1/bridge/host-tool-relay-authorization.ts", `const permissionCall = toolCall.name == null && toolCall.rawInput === void 0 && toolCall._meta === void 0 ? previous?.permissionCall : void 0;`, `const currentCall = resolveHostToolCall({ toolCall: merged, serverName, toolNames });
		const permissionCall = currentCall != null && previous?.permissionCall != null && callKey(currentCall) === callKey(previous.permissionCall) ? previous.permissionCall : void 0;`);
  source = replaceInRegion(source, "src/v1/bridge/permission-controller.ts", `const approvalId = \`acp-permission-\${++permissionRequestCounter}\`;`, `const approvalId = \`acp-permission-\${randomUUID()}\`;`);
  return source;
}

function replaceInRegion(source: string, region: string, before: string, after: string): string {
  const start = source.indexOf(`//#region ${region}`);
  const end = source.indexOf("//#endregion", start);
  if (start < 0 || end < start) throw new Error("Cursor host approval bridge region changed. Requalify the adapter.");
  const original = source.slice(start, end);
  if (original.split(after).length === 2 && !original.replace(after, "").includes(before)) return source;
  if (original.split(before).length !== 2) throw new Error("Cursor host approval bridge anchor changed. Requalify the adapter.");
  return source.slice(0, start) + original.replace(before, after) + source.slice(end);
}

export function withCursorHostToolApproval(harness: HarnessAgentAdapter): HarnessAgentAdapter {
  const getBootstrap = harness.getBootstrap?.bind(harness);
  if (!getBootstrap) throw new Error("Cursor host approval requires a bootstrap recipe.");
  let cached: Awaited<ReturnType<NonNullable<HarnessAgentAdapter["getBootstrap"]>>> | undefined;
  return {
    ...harness,
    getBootstrap: async (...args) => {
      if (cached) return cached;
      const bootstrap = await getBootstrap(...args);
      const path = `${bootstrap.bootstrapDir}/bridge.mjs`;
      const bridge = bootstrap.files.find((file) => file.path === path);
      if (!bridge || typeof bridge.content !== "string") throw new Error("Cursor approval bridge is missing. Requalify the adapter.");
      cached = { ...bootstrap, files: bootstrap.files.map((file) => file === bridge
        ? { ...file, content: patchCursorHostToolApproval(bridge.content) } : file) };
      return cached;
    },
  };
}
