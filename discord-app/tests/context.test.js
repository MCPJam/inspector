import assert from "node:assert/strict";
import test from "node:test";
import {
	buildInteractionRef,
	buildMessageRef,
	deriveConversationContext,
} from "../context.js";

/**
 * `threadId` used to be `message.id`.
 *
 * That gives every message in a thread a different thread id, so no binding
 * ever matches: channel-binding lookups miss, thread bindings are never
 * created, and each mention starts from nothing. Discord's own model is the
 * one to follow — a thread is a channel whose `parentId` is where it started.
 */

const channel = (overrides = {}) => ({
	id: "chan-1",
	isThread: () => false,
	parentId: null,
	...overrides,
});

const thread = (overrides = {}) =>
	channel({
		id: "thread-1",
		isThread: () => true,
		parentId: "chan-1",
		...overrides,
	});

test("a plain channel is its own conversation, with no thread", () => {
	assert.deepEqual(deriveConversationContext(channel()), {
		conversationId: "chan-1",
		threadId: undefined,
		isThread: false,
	});
});

test("a thread's conversation is its PARENT, and the thread is the thread", () => {
	assert.deepEqual(deriveConversationContext(thread()), {
		conversationId: "chan-1",
		threadId: "thread-1",
		isThread: true,
	});
});

test("every message in one thread derives the SAME pair", () => {
	// The property the old `threadId: message.id` broke. Two different messages,
	// same channel object: identical context, so a binding made on the first
	// turn is found on the second.
	const first = buildMessageRef({
		id: "msg-1",
		guildId: "g1",
		channelId: "thread-1",
		author: { id: "u1" },
		channel: thread(),
	});
	const second = buildMessageRef({
		id: "msg-2",
		guildId: "g1",
		channelId: "thread-1",
		author: { id: "u1" },
		channel: thread(),
	});
	assert.equal(first.ref.conversationId, second.ref.conversationId);
	assert.equal(first.ref.threadId, second.ref.threadId);
	assert.equal(first.ref.threadId, "thread-1");
	// And neither is a message id.
	assert.notEqual(first.ref.threadId, "msg-1");
});

test("a thread with no parentId falls back to the channel shape", () => {
	// Safe direction: a wrong 'not a thread' costs a binding; a wrong 'is a
	// thread' keys against a parentId that does not exist.
	assert.deepEqual(deriveConversationContext(thread({ parentId: null })), {
		conversationId: "thread-1",
		threadId: undefined,
		isThread: false,
	});
});

test("a partial channel that cannot answer isThread() is treated as a channel", () => {
	assert.deepEqual(deriveConversationContext({ id: "chan-9" }, "chan-9"), {
		conversationId: "chan-9",
		threadId: undefined,
		isThread: false,
	});
});

test("falls back to the supplied channel id when the channel is absent", () => {
	assert.deepEqual(deriveConversationContext(undefined, "chan-fallback"), {
		conversationId: "chan-fallback",
		threadId: undefined,
		isThread: false,
	});
});

test("a BUTTON click in a thread derives the same pair as the turn did", () => {
	// The approval path built its ref from `interaction.channelId` with no
	// thread mapping at all, so a click inside a thread looked up a binding
	// under the thread id and found none — an approval that should work
	// reporting "not linked".
	const turn = buildMessageRef({
		id: "msg-1",
		guildId: "g1",
		channelId: "thread-1",
		author: { id: "u1" },
		channel: thread(),
	});
	const click = buildInteractionRef({
		guildId: "g1",
		channelId: "thread-1",
		user: { id: "u2" },
		channel: thread(),
	});

	assert.equal(click.ref.conversationId, turn.ref.conversationId);
	assert.equal(click.ref.threadId, turn.ref.threadId);
	// Different person, same conversation — the clicker is the authorizer.
	assert.equal(click.ref.actorId, "u2");
	assert.equal(turn.ref.actorId, "u1");
});

test("omits threadId entirely outside a thread rather than sending undefined", () => {
	const { ref } = buildMessageRef({
		id: "msg-1",
		guildId: "g1",
		channelId: "chan-1",
		author: { id: "u1" },
		channel: channel(),
	});
	assert.equal("threadId" in ref, false);
});

test("carries the legacy project id through for pre-linking deployments", () => {
	const { ref } = buildMessageRef(
		{
			id: "m",
			guildId: "g1",
			channelId: "chan-1",
			author: { id: "u1" },
			channel: channel(),
		},
		{ legacyProjectId: "proj-legacy" },
	);
	assert.equal(ref.projectId, "proj-legacy");
});
