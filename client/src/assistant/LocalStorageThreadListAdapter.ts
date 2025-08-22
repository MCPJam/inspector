import type { RemoteThreadListAdapter, RemoteThreadListResponse, RemoteThreadInitializeResponse } from "@assistant-ui/react";

const STORAGE_KEY = "mcpjam.assistant.threads.meta";

type ThreadMeta = {
	remoteId: string;
	externalId?: string;
	title?: string;
	status: "regular" | "archived";
	createdAt: number;
	updatedAt: number;
};

type ThreadStore = {
	threads: Record<string, ThreadMeta>;
	order: string[];
	archivedOrder: string[];
};

function loadStore(): ThreadStore {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) {
			return { threads: {}, order: [], archivedOrder: [] };
		}
		const parsed = JSON.parse(raw) as ThreadStore;
		return parsed ?? { threads: {}, order: [], archivedOrder: [] };
	} catch {
		return { threads: {}, order: [], archivedOrder: [] };
	}
}

function saveStore(store: ThreadStore) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

export class LocalStorageThreadListAdapter implements RemoteThreadListAdapter {
	async list(): Promise<RemoteThreadListResponse> {
		const store = loadStore();
		const threads = [
			...store.order.map((id) => store.threads[id]).filter(Boolean),
			...store.archivedOrder.map((id) => store.threads[id]).filter(Boolean),
		];
		return {
			threads: threads.map((t) => ({
				remoteId: t.remoteId,
				externalId: t.externalId,
				title: t.title,
				status: t.status,
			})),
		};
	}

	async rename(remoteId: string, newTitle: string): Promise<void> {
		const store = loadStore();
		const t = store.threads[remoteId];
		if (t) {
			t.title = newTitle;
			t.updatedAt = Date.now();
			saveStore(store);
		}
	}

	async archive(remoteId: string): Promise<void> {
		const store = loadStore();
		const t = store.threads[remoteId];
		if (t && t.status !== "archived") {
			t.status = "archived";
			store.order = store.order.filter((id) => id !== remoteId);
			store.archivedOrder = [remoteId, ...store.archivedOrder.filter((id) => id !== remoteId)];
			t.updatedAt = Date.now();
			saveStore(store);
		}
	}

	async unarchive(remoteId: string): Promise<void> {
		const store = loadStore();
		const t = store.threads[remoteId];
		if (t && t.status !== "regular") {
			t.status = "regular";
			store.archivedOrder = store.archivedOrder.filter((id) => id !== remoteId);
			store.order = [remoteId, ...store.order.filter((id) => id !== remoteId)];
			t.updatedAt = Date.now();
			saveStore(store);
		}
	}

	async delete(remoteId: string): Promise<void> {
		const store = loadStore();
		delete store.threads[remoteId];
		store.order = store.order.filter((id) => id !== remoteId);
		store.archivedOrder = store.archivedOrder.filter((id) => id !== remoteId);
		saveStore(store);
	}

	async initialize(threadId: string): Promise<RemoteThreadInitializeResponse> {
		const store = loadStore();
		if (!store.threads[threadId]) {
			const meta: ThreadMeta = {
				remoteId: threadId,
				status: "regular",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			store.threads[threadId] = meta;
			store.order = [threadId, ...store.order.filter((id) => id !== threadId)];
			saveStore(store);
		}
		return { remoteId: threadId, externalId: undefined };
	}

	async generateTitle(): Promise<ReadableStream> {
		// Minimal: return an empty stream (no auto title generation)
		return new ReadableStream();
	}
}