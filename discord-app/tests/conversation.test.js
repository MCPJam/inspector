import assert from "node:assert/strict";
import test from "node:test";
import {
	deriveConversationIdentity,
	ensureThreadBinding,
} from "../conversation.js";

const channelMessage = (id, channelId) => ({
	id,
	channelId,
	channel: { isThread: () => false },
});

const threadMessage = (id, threadChannelId, parentId) => ({
	id,
	channelId: threadChannelId,
	channel: { isThread: () => true, parentId },
});

const silentLogger = { error() {} };

test("a channel mention keys on the channel and the message", () => {
	const identity = deriveConversationIdentity(channelMessage("MSG1", "CHAN1"));

	assert.deepEqual(identity, {
		inThread: false,
		conversationId: "CHAN1",
		threadId: "MSG1",
	});
});

test("a message in a thread keys on the parent channel and the thread", () => {
	const identity = deriveConversationIdentity(
		threadMessage("MSG2", "THREAD1", "CHAN1"),
	);

	assert.deepEqual(identity, {
		inThread: true,
		conversationId: "CHAN1",
		threadId: "THREAD1",
	});
});

test("a thread started from a mention derives the same key as the mention", () => {
	// This is the whole point of the derivation. A Discord thread started from a
	// message takes that message's id as its own channel id, so the binding the
	// first turn writes is the one later in-thread turns find.
	const mention = deriveConversationIdentity(channelMessage("MSG1", "CHAN1"));
	// ...someone starts a thread on MSG1, so the thread's channel id IS "MSG1".
	const reply = deriveConversationIdentity(
		threadMessage("MSG9", "MSG1", "CHAN1"),
	);

	assert.equal(reply.conversationId, mention.conversationId);
	assert.equal(reply.threadId, mention.threadId);
});

test("two messages in one thread derive one key, unlike the per-message id", () => {
	const first = deriveConversationIdentity(
		threadMessage("MSG2", "THREAD1", "CHAN1"),
	);
	const second = deriveConversationIdentity(
		threadMessage("MSG3", "THREAD1", "CHAN1"),
	);

	assert.deepEqual(first, second);
	// The old derivation used message.id as the threadId, which differed here
	// and is why no binding ever matched.
	assert.notEqual("MSG2", "MSG3");
});

test("an orphaned thread falls back to its own id rather than a null channel", () => {
	const identity = deriveConversationIdentity(
		threadMessage("MSG2", "THREAD1", null),
	);

	assert.deepEqual(identity, {
		inThread: true,
		conversationId: "THREAD1",
		threadId: "THREAD1",
	});
});

test("a message from a client without isThread is treated as a channel message", () => {
	const identity = deriveConversationIdentity({
		id: "MSG1",
		channelId: "CHAN1",
		channel: {},
	});

	assert.equal(identity.inThread, false);
	assert.equal(identity.conversationId, "CHAN1");
});

test("the first user-mode turn writes the thread binding", async () => {
	const calls = [];
	const backend = {
		createThreadBinding: async (body) => {
			calls.push(body);
			return { created: true, projectId: "P1", organizationId: "O1" };
		},
	};

	const result = await ensureThreadBinding({
		backend,
		ctx: { tenantId: "G1", actorId: "U1" },
		conversationId: "CHAN1",
		threadId: "MSG1",
		target: { mode: "user", projectId: "P1", organizationId: "O1" },
	});

	assert.deepEqual(result, { ok: true, projectId: "P1" });
	assert.deepEqual(calls, [
		{
			surfaceKind: "discord",
			surfaceTenantId: "G1",
			channelId: "CHAN1",
			threadTs: "MSG1",
			organizationId: "O1",
			projectId: "P1",
			initiatorSurfaceUserId: "U1",
		},
	]);
});

test("an already-bound thread is not rewritten", async () => {
	let called = false;
	const backend = {
		createThreadBinding: async () => {
			called = true;
			return { created: true, projectId: "P1" };
		},
	};

	const result = await ensureThreadBinding({
		backend,
		ctx: { tenantId: "G1", actorId: "U1" },
		conversationId: "CHAN1",
		threadId: "MSG1",
		target: {
			mode: "user",
			projectId: "P1",
			organizationId: "O1",
			boundThread: true,
		},
	});

	assert.equal(called, false);
	assert.deepEqual(result, { ok: true, projectId: "P1" });
});

test("legacy-mode turns do not bind", async () => {
	let called = false;
	const backend = {
		createThreadBinding: async () => {
			called = true;
			return { created: true, projectId: "P1" };
		},
	};

	const result = await ensureThreadBinding({
		backend,
		ctx: { tenantId: "G1", actorId: "U1" },
		conversationId: "CHAN1",
		threadId: "MSG1",
		target: { mode: "legacy", projectId: "PLEGACY" },
	});

	assert.equal(called, false);
	assert.deepEqual(result, { ok: true, projectId: "PLEGACY" });
});

test("a user-mode turn with no resolved project does not bind", async () => {
	// `resolveTurnTarget` has no branch that returns `user` without a projectId
	// (that case is `needs_project`), so this pins the guard rather than a live
	// path. Nothing is written, and the turn proceeds with no project — A3's
	// restored NO_PROJECT guard in the credential seam is what stops it there.
	let called = false;
	const backend = {
		createThreadBinding: async () => {
			called = true;
			return { created: true, projectId: "P1" };
		},
	};

	const result = await ensureThreadBinding({
		backend,
		ctx: { tenantId: "G1", actorId: "U1" },
		conversationId: "CHAN1",
		threadId: "MSG1",
		target: { mode: "user", organizationId: "O1" },
		logger: silentLogger,
	});

	assert.equal(called, false);
	assert.deepEqual(result, { ok: true, projectId: undefined });
});

test("the loser of a race adopts the winning binding's project", async () => {
	const backend = {
		// First writer wins server-side, so the losing turn is handed the
		// winner's project rather than its own resolution.
		createThreadBinding: async () => ({
			created: false,
			projectId: "P-WINNER",
			organizationId: "O1",
		}),
	};

	const result = await ensureThreadBinding({
		backend,
		ctx: { tenantId: "G1", actorId: "U1" },
		conversationId: "CHAN1",
		threadId: "MSG1",
		target: { mode: "user", projectId: "P-LOSER", organizationId: "O1" },
	});

	assert.deepEqual(result, { ok: true, projectId: "P-WINNER" });
});

test("a thrown binding write fails the turn", async () => {
	const backend = {
		createThreadBinding: async () => {
			throw new Error("backend down");
		},
	};

	const result = await ensureThreadBinding({
		backend,
		ctx: { tenantId: "G1", actorId: "U1" },
		conversationId: "CHAN1",
		threadId: "MSG1",
		target: { mode: "user", projectId: "P1", organizationId: "O1" },
		logger: silentLogger,
	});

	assert.deepEqual(result, { ok: false });
});

test("a 200 that pinned nothing fails the turn too", async () => {
	const backend = {
		// The backend answers this shape when the project is not in the org, and
		// nothing was written — a success status but not a successful bind.
		createThreadBinding: async () => ({
			created: false,
			reason: "project_not_in_org",
		}),
	};

	const result = await ensureThreadBinding({
		backend,
		ctx: { tenantId: "G1", actorId: "U1" },
		conversationId: "CHAN1",
		threadId: "MSG1",
		target: { mode: "user", projectId: "P1", organizationId: "O1" },
		logger: silentLogger,
	});

	assert.deepEqual(result, { ok: false });
});
