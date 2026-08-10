import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { InstallationBackendError, mintConnectUrl } from "../src/index.js";

/**
 * `mintConnectUrl`'s direct-fetch branch (no `backend` — today: discord-app)
 * used to have none of the robustness slack-app/agent/connect-link.js has
 * always had: no timeout, no TIMEOUT/NETWORK error-code mapping, and a
 * `.catch(() => null)` on the body parse that swallowed a mid-stream read
 * failure the same way it swallows an empty body. These pin the fix.
 */

const BASE = { baseUrl: "https://app.mcpjam.com", token: "tok" };

function jsonResponse(body, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

test("the happy path is unaffected: mints, validates the origin, returns the url", async () => {
	const fetchImpl = async () =>
		jsonResponse({ url: "https://app.mcpjam.com/connect?t=x" });
	const url = await mintConnectUrl({ ...BASE, fetchImpl });
	assert.equal(url, "https://app.mcpjam.com/connect?t=x");
});

test("a network failure maps to a NETWORK-coded InstallationBackendError", async () => {
	const fetchImpl = async () => {
		throw new TypeError("fetch failed");
	};
	await assert.rejects(mintConnectUrl({ ...BASE, fetchImpl }), (error) => {
		assert.ok(error instanceof InstallationBackendError);
		assert.equal(error.code, "NETWORK");
		return true;
	});
});

test("a timeout maps to a TIMEOUT-coded error, driven in milliseconds via timeoutMs", async () => {
	const fetchImpl = mock.fn(async (_url, init) => {
		await new Promise((resolve, reject) => {
			init.signal.addEventListener("abort", () => {
				const error = new Error("aborted");
				error.name = "AbortError";
				reject(error);
			});
			// Never resolves on its own — the abort is the only exit, exactly like
			// the real request the abort is standing in for.
			setTimeout(resolve, 60_000).unref?.();
		});
		return jsonResponse({ url: "x" });
	});
	await assert.rejects(
		mintConnectUrl({ ...BASE, fetchImpl, timeoutMs: 1 }),
		(error) => {
			assert.ok(error instanceof InstallationBackendError);
			assert.equal(error.code, "TIMEOUT");
			return true;
		},
	);
});

test("an empty/malformed body on a non-ok response still surfaces the HTTP status", async () => {
	const fetchImpl = async () => new Response("not json", { status: 503 });
	await assert.rejects(mintConnectUrl({ ...BASE, fetchImpl }), (error) => {
		assert.ok(error instanceof InstallationBackendError);
		assert.equal(error.status, 503);
		return true;
	});
});

test("a body read failure that is NOT a parse error propagates, instead of reading as 'no url'", async () => {
	// Simulates a stream error mid-read: response.json() rejects with something
	// other than SyntaxError. `.catch(() => null)` used to launder this into a
	// silent 'no url', which then reported as the generic 'did not return a
	// connect link' — hiding that the request itself actually failed.
	const fetchImpl = async () => ({
		ok: true,
		status: 200,
		json: async () => {
			throw new Error("stream reset");
		},
	});
	await assert.rejects(mintConnectUrl({ ...BASE, fetchImpl }), /stream reset/);
});

test("missing config still throws CONFIG before any fetch happens", async () => {
	const fetchImpl = mock.fn(async () => jsonResponse({ url: "x" }));
	await assert.rejects(
		mintConnectUrl({ baseUrl: undefined, token: undefined, fetchImpl }),
		(error) => {
			assert.ok(error instanceof InstallationBackendError);
			assert.equal(error.code, "CONFIG");
			return true;
		},
	);
	assert.equal(fetchImpl.mock.callCount(), 0);
});
