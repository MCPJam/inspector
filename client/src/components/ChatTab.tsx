import { useMemo, useRef, useState } from "react";
import { AssistantRuntimeProvider, useLocalThreadRuntime, unstable_useRemoteThreadListRuntime, useThreadListItem } from "@assistant-ui/react";
import { ThreadPrimitive as Thread, ThreadListPrimitive as ThreadList, ComposerPrimitive as Composer } from "@assistant-ui/react";
import type { MastraMCPServerDefinition, ModelDefinition } from "@/shared/types.js";
import { LocalStorageThreadListAdapter } from "@/assistant/LocalStorageThreadListAdapter";
import { createMCPChatModelAdapter } from "@/assistant/ChatModelAdapter";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { SUPPORTED_MODELS } from "@/shared/types.js";
import { ChatTabLegacy } from "./ChatTabLegacy";
import { ToolSelection, getSelectedToolsForThread } from "@/assistant/ToolSelection";

interface ChatTabProps {
	serverConfigs?: Record<string, MastraMCPServerDefinition>;
	systemPrompt?: string;
}

export function ChatTab({ serverConfigs, systemPrompt = "" }: ChatTabProps) {
	const { getToken, hasToken, getOllamaBaseUrl } = useAiProviderKeys();

	// Filter models to only those with active provider tokens; include Ollama if available
	const availableModels = useMemo<ModelDefinition[]>(() => {
		const list: ModelDefinition[] = [];
		for (const model of SUPPORTED_MODELS) {
			if (model.provider === "anthropic" && hasToken("anthropic")) list.push(model);
			if (model.provider === "openai" && hasToken("openai")) list.push(model);
			if (model.provider === "deepseek" && hasToken("deepseek")) list.push(model);
		}
		return list;
	}, [hasToken]);

	const [selectedModelId, setSelectedModelId] = useState<string | null>(availableModels[0]?.id ?? null);
	const selectedModel = useMemo(() => availableModels.find((m) => String(m.id) === String(selectedModelId)) || null, [availableModels, selectedModelId]);

	const chatAdapter = useMemo(() =>
		createMCPChatModelAdapter({
			getServerConfigs: () => serverConfigs,
			getModel: () => (selectedModel ? { id: String(selectedModel.id), provider: selectedModel.provider } : null),
			getApiKey: () => (selectedModel ? (selectedModel.provider === "ollama" ? "local" : getToken(selectedModel.provider)) : ""),
			getSystemPrompt: () => systemPrompt,
			getOllamaBaseUrl: () => getOllamaBaseUrl(),
		}),
	[serverConfigs, selectedModel, getToken, systemPrompt, getOllamaBaseUrl]
	);

	const threadListAdapterRef = useRef(new LocalStorageThreadListAdapter());

	const runtime = unstable_useRemoteThreadListRuntime({
		runtimeHook: () => useLocalThreadRuntime(chatAdapter, { adapters: {} }),
		adapter: threadListAdapterRef.current,
	});

	// Minimal model selector using Assistant UI composer area for placement
	const ModelSelector = () => {
		return (
			<div className="flex items-center gap-2 text-xs text-muted-foreground">
				<label className="sr-only">Model</label>
				<select
					className="h-7 rounded-md border bg-background px-2"
					value={selectedModelId ?? ""}
					onChange={(e) => setSelectedModelId(e.target.value)}
				>
					{availableModels.map((m) => (
						<option key={String(m.id)} value={String(m.id)}>
							{m.name}
						</option>
					))}
				</select>
			</div>
		);
	};

	const ThreadHeader = () => {
		const { remoteId } = useThreadListItem();
		const threadId = remoteId || "main";
		return (
			<div className="border-b px-3 py-2 flex items-center gap-3 justify-between">
				<div className="text-sm font-medium">Assistant</div>
				<div className="flex items-center gap-3">
					<ToolSelection threadId={threadId} serverConfigs={serverConfigs} />
					<ModelSelector />
				</div>
			</div>
		);
	};

	return (
		<div className="flex h-[calc(100vh-48px)]">
			<AssistantRuntimeProvider runtime={runtime}>
				<div className="w-64 shrink-0 border-r p-2 hidden md:block">
					<ThreadList.Root>
						<ThreadList.New />
						<ThreadList.Items />
					</ThreadList.Root>
				</div>
				<div className="flex-1 flex flex-col">
					<Thread.Root>
						<ThreadHeader />
						<Thread.Viewport className="flex-1 overflow-y-auto p-4">
							<Thread.Messages />
						</Thread.Viewport>
						<div className="border-t p-3">
							<Composer.Root>
								<Composer.Input placeholder="Send a message..." />
								<div className="flex items-center justify-end gap-2 mt-2">
									<Composer.Cancel />
									<Composer.Send />
								</div>
							</Composer.Root>
						</div>
					</Thread.Root>
				</div>
			</AssistantRuntimeProvider>
			{/* Keep legacy code imported but not rendered for now: <ChatTabLegacy serverConfigs={serverConfigs} systemPrompt={systemPrompt} /> */}
		</div>
	);
}
