import type {
	ChatModelAdapter,
	ChatModelRunOptions,
	ChatModelRunResult,
} from "@assistant-ui/react";
import type {
	ThreadAssistantMessagePart,
	ToolCallMessagePart,
} from "@assistant-ui/react";

function getSelectedToolsForThread(threadId: string): string[] {
	try {
		const raw = localStorage.getItem("mcpjam.assistant.thread.tools");
		if (!raw) return [];
		const store = JSON.parse(raw) as Record<string, string[]>;
		return store[threadId] || [];
	} catch {
		return [];
	}
}

// Maps our SSE stream from /api/mcp/chat to Assistant UI updates
export const createMCPChatModelAdapter = (
	params: {
		getServerConfigs: () => Record<string, any> | undefined;
		getModel: () => { id: string; provider: string } | null;
		getApiKey: () => string;
		getSystemPrompt: () => string | undefined;
		getOllamaBaseUrl: () => string | undefined;
	}
): ChatModelAdapter => {
	return {
		async *run(options: ChatModelRunOptions) {
			const { abortSignal, unstable_getMessage } = options;

			const threadId = options.unstable_getMessage().id || "main";
			const selectedTools = getSelectedToolsForThread(threadId);

			const body = {
				serverConfigs: params.getServerConfigs(),
				model: params.getModel(),
				provider: params.getModel()?.provider,
				apiKey: params.getApiKey(),
				systemPrompt: params.getSystemPrompt(),
				messages: options.messages.map((m) => {
					if (m.role === "assistant") {
						// Convert assistant content back to plain text for server
						const text = (m.content || [])
							.filter((p) => p.type === "text")
							.map((p: any) => p.text)
							.join("");
						return { role: "assistant", content: text };
					} else if (m.role === "user") {
						const text = (m.content || [])
							.filter((p) => p.type === "text")
							.map((p: any) => p.text)
							.join("");
						return { role: "user", content: text };
					}
					return { role: m.role, content: "" };
				}),
				ollamaBaseUrl: params.getOllamaBaseUrl(),
				selectedTools,
			};

			const res = await fetch("/api/mcp/chat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
				signal: abortSignal,
			});

			if (!res.ok || !res.body) {
				throw new Error("Chat request failed");
			}

			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			const assistantParts: ThreadAssistantMessagePart[] = [];
			const toolCallMap = new Map<number, ToolCallMessagePart>();

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) {
					if (!line.startsWith("data: ")) continue;
					const data = line.slice(6).trim();
					if (!data) continue;
					if (data === "[DONE]") {
						return;
					}
					try {
						const evt = JSON.parse(data);
						if (evt.type === "text" && evt.content) {
							assistantParts.push({ type: "text", text: evt.content });
							yield { content: [...assistantParts] } satisfies ChatModelRunResult;
							continue;
						}

						if (evt.type === "tool_call" && evt.toolCall) {
							const idNum = evt.toolCall.id as number;
							const part: ToolCallMessagePart = {
								type: "tool-call",
								toolCallId: String(idNum),
								toolName: evt.toolCall.name,
								args: evt.toolCall.parameters || {},
								argsText: JSON.stringify(evt.toolCall.parameters || {}),
							};
							toolCallMap.set(idNum, part);
							assistantParts.push(part);
							yield { content: [...assistantParts] } satisfies ChatModelRunResult;
							continue;
						}

						if (evt.type === "tool_result" && evt.toolResult) {
							const idNum = evt.toolResult.toolCallId as number;
							const existing = toolCallMap.get(idNum);
							if (existing) {
								existing.result = evt.toolResult.result;
								existing.isError = Boolean(evt.toolResult.error);
							}
							// Refresh assistant parts to reflect result binding
							yield { content: [...assistantParts] } satisfies ChatModelRunResult;
							continue;
						}

						if (evt.type === "elicitation_request") {
							// For simplicity, expose as text note; full UI handled by Assistant UI if supported
							assistantParts.push({ type: "text", text: `Elicitation requested: ${evt.message}` });
							yield { content: [...assistantParts] } satisfies ChatModelRunResult;
							continue;
						}
					} catch {}
				}
			}
		},
	};
};