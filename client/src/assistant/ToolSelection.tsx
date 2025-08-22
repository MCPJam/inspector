import { useEffect, useMemo, useState } from "react";

const STORAGE_KEY = "mcpjam.assistant.thread.tools";

type ToolSelectionStore = Record<string, string[]>; // threadId -> selected tool names

function loadStore(): ToolSelectionStore {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") as ToolSelectionStore;
	} catch {
		return {};
	}
}

function saveStore(store: ToolSelectionStore) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

async function fetchAllTools(serverConfigs?: Record<string, any>): Promise<string[]> {
	if (!serverConfigs) return [];
	const serverNames = Object.keys(serverConfigs);
	const toolNames = new Set<string>();
	await Promise.all(
		serverNames.map(async (name) => {
			try {
				const res = await fetch("/api/mcp/tools", {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
					body: JSON.stringify({ action: "list", serverConfig: serverConfigs[name] }),
				});
				const reader = res.body?.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				if (!reader) return;
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						const data = line.slice(6).trim();
						if (data === "[DONE]") break;
						try {
							const evt = JSON.parse(data);
							if (evt.type === "tools_list" && evt.tools) {
								Object.keys(evt.tools).forEach((t) => toolNames.add(t));
							}
						} catch {}
					}
				}
			} catch {}
		}),
	);
	return Array.from(toolNames);
}

export function ToolSelection({ threadId, serverConfigs }: { threadId: string; serverConfigs?: Record<string, any> }) {
	const [allTools, setAllTools] = useState<string[]>([]);
	const [store, setStore] = useState<ToolSelectionStore>(() => loadStore());

	useEffect(() => {
		fetchAllTools(serverConfigs).then(setAllTools);
	}, [serverConfigs]);

	const selected = store[threadId] || [];

	useEffect(() => {
		saveStore(store);
	}, [store]);

	const toggle = (name: string) => {
		setStore((s) => {
			const next = { ...s };
			const set = new Set(next[threadId] || []);
			if (set.has(name)) set.delete(name);
			else set.add(name);
			next[threadId] = Array.from(set);
			return next;
		});
	};

	if (allTools.length === 0) return null;

	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<span className="font-medium">Tools</span>
			<div className="flex flex-wrap gap-1">
				{allTools.map((t) => (
					<button
						key={t}
						onClick={() => toggle(t)}
						className={`h-6 px-2 rounded border ${selected.includes(t) ? "bg-primary text-primary-foreground" : "bg-background"}`}
						title={t}
					>
						{t}
					</button>
				))}
			</div>
		</div>
	);
}

export function getSelectedToolsForThread(threadId: string): string[] {
	const s = loadStore();
	return s[threadId] || [];
}