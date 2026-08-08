import assert from "node:assert/strict";
import test from "node:test";
import { deriveConversation, ensureThreadBinding } from "../conversation.js";

const channelMessage = {
	id: "msg-100",
	channelId: "chan-1",
	channel: { isThread: () => false },
};

const threadMessage = {
	id: "msg-200",
	channelId: "thread-9",
	channel: { isThread: () => true, parentId: "chan-1" },
};

test("a top-level message roots its own conversation, like Slack keying on the root ts", () => {
	assert.deepEqual(deriveConversation(channelMessage), {
		conversationId: "chan-1",
		threadId: "msg-100",
		inThread: false,
	});
});

test("a thread message keys on the thread channel, not its own id — the binding must be findable next turn", () => {
	const first = deriveConversation(threadMessage);
	const second = deriveConversation({ ...threadMessage, id: "msg-201" });
	assert.deepEqual(first, {
		conversationId: "chan-1",
		threadId: "thread-9",
		inThread: true,
	});
	// The old shape (threadId = message.id) made this differ per message.
	assert.deepEqual(second, first);
});

test("a channel object without isThread is treated as a plain channel", () => {
	assert.equal(
		deriveConversation({ id: "m", channelId: "c", channel: {} }).threadId,
		"m",
	);
});

function backendRecording(result) {
	const calls = [];
	return {
		calls,
		createThreadBinding: async (args) => {
			calls.push(args);
			if (result instanceof Error) throw result;
			return result;
		},
	};
}

const userTarget = {
	mode: "user",
	projectId: "proj-1",
	organizationId: "org-1",
};

const bindingArgs = (backend) => ({
	backend,
	target: userTarget,
	tenantId: "guild-1",
	actorId: "user-1",
	conversationId: "chan-1",
	threadId: "thread-9",
});

test("an already-bound thread writes nothing", async () => {
	const backend = backendRecording({ created: true });
	const out = await ensureThreadBinding({
		...bindingArgs(backend),
		target: { ...userTarget, boundThread: true },
	});
	assert.deepEqual(out, { ok: true, projectId: "proj-1" });
	assert.equal(backend.calls.length, 0);
});

test("legacy mode writes nothing", async () => {
	const backend = backendRecording({ created: true });
	const out = await ensureThreadBinding({
		...bindingArgs(backend),
		target: { mode: "legacy", projectId: "proj-legacy" },
	});
	assert.deepEqual(out, { ok: true, projectId: "proj-legacy" });
	assert.equal(backend.calls.length, 0);
});

test("a fresh user turn writes the binding with the exact wire field names", async () => {
	const backend = backendRecording({
		created: true,
		organizationId: "org-1",
		projectId: "proj-1",
	});
	const out = await ensureThreadBinding(bindingArgs(backend));
	assert.deepEqual(out, { ok: true, projectId: "proj-1" });
	// Pin the deployed contract (backend surfaceRoutes.ts): `threadTs` and
	// `initiatorSurfaceUserId`, not the resolver's local vocabulary.
	assert.deepEqual(backend.calls, [
		{
			surfaceKind: "discord",
			surfaceTenantId: "guild-1",
			channelId: "chan-1",
			threadTs: "thread-9",
			projectId: "proj-1",
			organizationId: "org-1",
			initiatorSurfaceUserId: "user-1",
		},
	]);
});

test("a lost first-writer race adopts the EXISTING binding's project", async () => {
	const backend = backendRecording({
		created: false,
		organizationId: "org-2",
		projectId: "proj-existing",
		initiatorSurfaceUserId: "someone-else",
	});
	const out = await ensureThreadBinding(bindingArgs(backend));
	assert.deepEqual(out, { ok: true, projectId: "proj-existing" });
});

test("a rejected write fails the turn — never a silent downgrade to unbound", async () => {
	const rejected = backendRecording({
		created: false,
		reason: "project_not_in_org",
	});
	assert.deepEqual(await ensureThreadBinding(bindingArgs(rejected)), {
		ok: false,
	});

	const unreachable = backendRecording(new Error("backend down"));
	assert.deepEqual(await ensureThreadBinding(bindingArgs(unreachable)), {
		ok: false,
	});
});
