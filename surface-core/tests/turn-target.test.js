import assert from "node:assert";
import { describe, it } from "node:test";

import { createTurnTargetResolver } from "../src/turn-target.js";

const CTX = { tenantId: "T1", actorId: "U1" };

/** A backend whose three lookups are scripted per test. */
function backendWith({
	threadBinding = null,
	channelBinding = null,
	link = null,
} = {}) {
	return {
		fetchThreadBinding: async () => threadBinding,
		fetchChannelBinding: async () => channelBinding,
		fetchAccountLink: async () => link,
	};
}

describe("turn target precedence", () => {
	it("a bound thread wins, and does not need the speaker to be linked", async () => {
		const resolve = createTurnTargetResolver({
			surfaceKind: "test",
			backend: backendWith({
				threadBinding: {
					projectId: "p_thread",
					organizationId: "o1",
					initiatorActorId: "U9",
				},
				channelBinding: { projectId: "p_channel", organizationId: "o1" },
				link: { organizationId: "o1", defaultProjectId: "p_user" },
			}),
		});
		const target = await resolve(CTX, {
			conversationId: "C1",
			threadId: "ts1",
		});
		assert.deepEqual(target, {
			mode: "user",
			projectId: "p_thread",
			organizationId: "o1",
			initiatorActorId: "U9",
			boundThread: true,
		});
	});

	it("a channel binding outranks the speaker’s own default", async () => {
		const resolve = createTurnTargetResolver({
			surfaceKind: "test",
			backend: backendWith({
				channelBinding: { projectId: "p_channel", organizationId: "o1" },
				link: { organizationId: "o1", defaultProjectId: "p_user" },
			}),
		});
		const target = await resolve(CTX, { conversationId: "C1" });
		assert.equal(target.projectId, "p_channel");
		assert.equal(target.boundChannel, true);
	});

	it("ignores a channel binding written by a DIFFERENT org", async () => {
		// One workspace can host two orgs. Honouring the binding here would let
		// org A decide a turn for a member of org B.
		const resolve = createTurnTargetResolver({
			surfaceKind: "test",
			backend: backendWith({
				channelBinding: { projectId: "p_other_org", organizationId: "o_other" },
				link: { organizationId: "o1", defaultProjectId: "p_user" },
			}),
		});
		const target = await resolve(CTX, { conversationId: "C1" });
		assert.equal(target.projectId, "p_user");
		assert.equal(target.boundChannel, undefined);
	});

	it("does not run an UNLINKED speaker in a bound channel", async () => {
		// They get the connect button instead of an inevitable 401.
		const resolve = createTurnTargetResolver({
			surfaceKind: "test",
			backend: backendWith({
				channelBinding: { projectId: "p_channel", organizationId: "o1" },
			}),
		});
		assert.deepEqual(await resolve(CTX, { conversationId: "C1" }), {
			mode: "unlinked",
		});
	});

	it("falls back to the ORG default only when the user has none", async () => {
		const withUserDefault = createTurnTargetResolver({
			surfaceKind: "test",
			backend: backendWith({
				link: {
					organizationId: "o1",
					defaultProjectId: "p_user",
					orgDefaultProjectId: "p_org",
				},
			}),
		});
		const chosen = await withUserDefault(CTX, { conversationId: "C1" });
		assert.equal(
			chosen.projectId,
			"p_user",
			"the org default must never override a personal one",
		);
		assert.equal(chosen.orgDefault, undefined);

		const withoutUserDefault = createTurnTargetResolver({
			surfaceKind: "test",
			backend: backendWith({
				link: { organizationId: "o1", orgDefaultProjectId: "p_org" },
			}),
		});
		const fallback = await withoutUserDefault(CTX, { conversationId: "C1" });
		assert.equal(fallback.projectId, "p_org");
		assert.equal(fallback.orgDefault, true);
	});

	it("asks for a project when the org has no default either", async () => {
		const resolve = createTurnTargetResolver({
			surfaceKind: "test",
			backend: backendWith({ link: { organizationId: "o1" } }),
		});
		assert.deepEqual(await resolve(CTX, { conversationId: "C1" }), {
			mode: "needs_project",
			organizationId: "o1",
		});
	});

	it("a backend with no channel-binding support resolves normally", async () => {
		// `fetchChannelBinding` absent entirely reads as "no binding", not a crash.
		const resolve = createTurnTargetResolver({
			surfaceKind: "test",
			backend: {
				fetchThreadBinding: async () => null,
				fetchAccountLink: async () => ({
					organizationId: "o1",
					defaultProjectId: "p_user",
				}),
			},
		});
		assert.equal(
			(await resolve(CTX, { conversationId: "C1" })).projectId,
			"p_user",
		);
	});

	it("fetches the channel binding and the link concurrently", async () => {
		// Sequential lookups would add a round trip to the hot path of exactly the
		// channels an org configured to be frictionless.
		const order = [];
		const resolve = createTurnTargetResolver({
			surfaceKind: "test",
			backend: {
				fetchThreadBinding: async () => null,
				fetchChannelBinding: async () => {
					order.push("channel:start");
					await new Promise((r) => setTimeout(r, 10));
					order.push("channel:end");
					return null;
				},
				fetchAccountLink: async () => {
					order.push("link:start");
					return { organizationId: "o1", defaultProjectId: "p_user" };
				},
			},
		});
		await resolve(CTX, { conversationId: "C1" });
		assert.deepEqual(order.slice(0, 2), ["channel:start", "link:start"]);
	});
});
