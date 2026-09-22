import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createBackendClient } from "../src/backend-client.js";

/**
 * The thread-binding READ and WRITE must speak the same body vocabulary.
 *
 * `createThreadBinding` used to forward a raw `args` object verbatim, which put
 * the wire names on every caller — and they are not guessable. The backend
 * wants `surfaceTenantId`/`surfaceUserId` and calls the thread `threadTs`
 * (Slack's word, kept when the route was generalized), while a surface has
 * `tenantId`, `actorId` and `threadId`. Discord passed its own spelling, so the
 * route rejected every write with a 400 and threads silently stayed unbound —
 * indistinguishable from the backend being down, and it meant the next person
 * to speak in the thread resolved to THEIR default project.
 *
 * These pin the two calls against each other rather than against a hardcoded
 * body, so a rename that touches one and not the other fails here.
 */

const CTX = { tenantId: "guild-1", actorId: "user-1" };

/** A client whose single outbound POST is captured instead of sent. */
function clientCapturing() {
	const calls = [];
	const client = createBackendClient({
		surfaceKind: "discord",
		baseUrl: "https://backend.test",
		serviceToken: "tok",
		authHeaderName: "x-discord-service-token",
		routePrefix: "/agent",
		fetchImpl: async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(init.body) });
			return new Response(JSON.stringify({ ok: true, binding: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		},
	});
	return { client, calls };
}

describe("thread binding: read and write agree", () => {
	it("identifies a binding the same way on create as on get", async () => {
		const { client, calls } = clientCapturing();

		await client.fetchThreadBinding(CTX, "parent-channel", "thread-9");
		await client.createThreadBinding(CTX, "parent-channel", "thread-9", {
			projectId: "proj_1",
			organizationId: "org_1",
		});

		const [read, write] = calls;
		assert.match(read.url, /\/agent\/thread-bindings\/get$/);
		assert.match(write.url, /\/agent\/thread-bindings\/create$/);

		// Every field the read uses to FIND a binding must be spelled identically
		// on the write that CREATES it — otherwise the write lands somewhere the
		// read will never look.
		for (const key of [
			"surfaceKind",
			"surfaceTenantId",
			"surfaceUserId",
			"channelId",
			"threadTs",
		]) {
			assert.equal(write.body[key], read.body[key], `mismatch on ${key}`);
		}
	});

	it("sends the fields the create route requires, and no undefined ones", async () => {
		const { client, calls } = clientCapturing();

		await client.createThreadBinding(CTX, "parent-channel", "thread-9", {
			projectId: "proj_1",
			organizationId: "org_1",
		});

		// The route 400s unless ALL of these are present as non-empty strings.
		assert.deepEqual(calls[0].body, {
			surfaceKind: "discord",
			surfaceTenantId: "guild-1",
			surfaceUserId: "user-1",
			channelId: "parent-channel",
			threadTs: "thread-9",
			projectId: "proj_1",
			organizationId: "org_1",
			// Resolved to an account link server-side and checked against
			// `organizationId`; a mismatch is rejected. That check is what stops a
			// thread being bound to an org the initiator is not a member of.
			initiatorSurfaceUserId: "user-1",
		});
	});
});
